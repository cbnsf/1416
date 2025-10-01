// netlify/functions/airdrop.js
const { Connection, PublicKey, Keypair, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const { getAssociatedTokenAddress, createTransferInstruction, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const bs58 = require('bs58');

exports.handler = async (event, context) => {
  // 设置 CORS 头
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // 处理预检请求
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  // 只允许 POST 请求
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { walletAddress } = JSON.parse(event.body);
    
    if (!walletAddress) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Wallet address is required' })
      };
    }

    // 从环境变量获取配置
    const senderPrivateKey = process.env.SENDER_PRIVATE_KEY;
    const tokenMintAddress = process.env.TOKEN_MINT_ADDRESS;
    const rpcUrl = process.env.RPC_URL;
    const tokenAmount = parseInt(process.env.TOKEN_AMOUNT || '25000');

    // 检查环境变量
    if (!senderPrivateKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Missing SENDER_PRIVATE_KEY environment variable' })
      };
    }
    if (!tokenMintAddress) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Missing TOKEN_MINT_ADDRESS environment variable' })
      };
    }
    if (!rpcUrl) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Missing RPC_URL environment variable' })
      };
    }

    console.log('Starting Solana transaction for:', walletAddress);

    // 解析发送者私钥
    let senderKeypair;
    try {
      let privateKeyArray;
      if (senderPrivateKey.startsWith('[')) {
        // JSON数组格式
        privateKeyArray = JSON.parse(senderPrivateKey);
      } else {
        // Base58格式
        privateKeyArray = Array.from(bs58.decode(senderPrivateKey));
      }
      senderKeypair = Keypair.fromSecretKey(new Uint8Array(privateKeyArray));
      console.log('Sender keypair created:', senderKeypair.publicKey.toString());
    } catch (error) {
      console.error('Error parsing private key:', error);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Invalid sender private key format' })
      };
    }

    // 创建连接
    const connection = new Connection(rpcUrl, 'confirmed');
    console.log('Connected to RPC:', rpcUrl);

    // 创建代币mint的公钥
    const mintPublicKey = new PublicKey(tokenMintAddress);
    console.log('Token mint:', mintPublicKey.toString());

    // 区块链状态检查
    console.log('Checking blockchain state for recipient...');
    
    try {
      const recipientTokenAccount = await getAssociatedTokenAddress(
        mintPublicKey,
        new PublicKey(walletAddress)
      );
      
      // 检查代币账户是否存在且有余额
      try {
        const recipientBalance = await connection.getTokenAccountBalance(recipientTokenAccount);
        console.log('Recipient current balance:', recipientBalance.value.uiAmount);
        
        // 如果钱包已经有代币余额，认为已经领取过
        if (recipientBalance.value.uiAmount > 0) {
          console.log('Wallet already has DUCK tokens:', walletAddress);
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'already_has_tokens' })
          };
        }
      } catch (error) {
        // 如果代币账户不存在，说明没有领取过，这是正常情况
        console.log('Recipient has no token account yet, proceeding with airdrop');
      }
    } catch (error) {
      console.error('Error checking recipient balance:', error);
    }

    // 获取发送者的代币账户地址
    const senderTokenAccount = await getAssociatedTokenAddress(
      mintPublicKey,
      senderKeypair.publicKey
    );
    console.log('Sender token account:', senderTokenAccount.toString());

    // 获取接收者的代币账户地址
    const recipientTokenAccount = await getAssociatedTokenAddress(
      mintPublicKey,
      new PublicKey(walletAddress)
    );
    console.log('Recipient token account:', recipientTokenAccount.toString());

    // 检查发送者余额
    let senderBalance;
    try {
      senderBalance = await connection.getTokenAccountBalance(senderTokenAccount);
      console.log('Sender balance:', senderBalance.value.uiAmount);
      
      if (senderBalance.value.uiAmount < tokenAmount) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'insufficient_token_balance' })
        };
      }
    } catch (error) {
      console.error('Error checking sender balance:', error);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Cannot check sender token balance' })
      };
    }

    // 检查接收者是否已经有代币账户
    let recipientTokenAccountInfo;
    try {
      recipientTokenAccountInfo = await connection.getAccountInfo(recipientTokenAccount);
      console.log('Recipient token account exists:', !!recipientTokenAccountInfo);
    } catch (error) {
      console.log('Recipient token account does not exist, will create it');
    }

    const transaction = new Transaction();

    // 如果接收者没有代币账户，需要先创建
    if (!recipientTokenAccountInfo) {
      console.log('Creating associated token account for recipient');
      const createATAInstruction = createAssociatedTokenAccountInstruction(
        senderKeypair.publicKey, // 支付账户
        recipientTokenAccount,   // 关联代币账户地址
        new PublicKey(walletAddress), // 代币所有者
        mintPublicKey           // 代币mint地址
      );
      transaction.add(createATAInstruction);
    }

    // 添加转账指令
    const decimals = 9; // 根据你的代币实际情况修改
    const transferAmount = tokenAmount * Math.pow(10, decimals);
    
    console.log(`Transferring ${tokenAmount} tokens (${transferAmount} raw units)`);
    
    const transferInstruction = createTransferInstruction(
      senderTokenAccount,        // 发送者代币账户
      recipientTokenAccount,     // 接收者代币账户
      senderKeypair.publicKey,   // 发送者地址
      transferAmount            // 转账数量
    );
    transaction.add(transferInstruction);

    // 设置最新的区块哈希
    console.log('Getting latest blockhash...');
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = senderKeypair.publicKey;

    console.log('Sending transaction...');

    // 发送交易
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [senderKeypair],
      {
        commitment: 'confirmed',
        skipPreflight: false
      }
    );

    console.log('Transaction successful! Signature:', signature);

    // 返回交易签名
    const cluster = rpcUrl.includes('devnet') ? 'devnet' : 'mainnet';
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        signature: signature,
        amount: tokenAmount,
        message: `Successfully airdropped ${tokenAmount} DUCK tokens`,
        explorerUrl: `https://solscan.io/tx/${signature}?cluster=${cluster}`
      })
    };

  } catch (error) {
    console.error('Airdrop error:', error);

    // 处理特定错误
    if (error.message.includes('already in use')) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'already_claimed_or_has_balance' })
      };
    }

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: error.message || 'Internal server error during airdrop' 
      })
    };
  }
};