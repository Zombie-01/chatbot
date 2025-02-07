import { NextApiRequest, NextApiResponse } from 'next';
import { Chatbot } from '@/lib/chatbot';

// Rate limiting configuration
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 100;
const ipRequests = new Map<string, { count: number; timestamp: number }>();

// Chatbot instance cache
let chatbot: Chatbot | null = null;

// Rate limiting middleware
function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW;
  
  // Clean up old entries
  for (const [key, data] of ipRequests.entries()) {
    if (data.timestamp < windowStart) {
      ipRequests.delete(key);
    }
  }

  const requestData = ipRequests.get(ip) || { count: 0, timestamp: now };
  
  if (requestData.timestamp < windowStart) {
    requestData.count = 0;
    requestData.timestamp = now;
  }
  
  requestData.count++;
  ipRequests.set(ip, requestData);
  
  return requestData.count <= MAX_REQUESTS_PER_WINDOW;
}

// Validate environment variables
function validateEnvironment(): { isValid: boolean; error?: string } {
  if (!process.env.PAGE_ACCESS_TOKEN) {
    return { isValid: false, error: 'Missing PAGE_ACCESS_TOKEN environment variable' };
  }
  if (!process.env.VERIFY_TOKEN) {
    return { isValid: false, error: 'Missing VERIFY_TOKEN environment variable' };
  }
  return { isValid: true };
}

// Initialize or get chatbot instance
function getChatbot(): Chatbot {
  if (!chatbot) {
    const envCheck = validateEnvironment();
    if (!envCheck.isValid) {
      throw new Error(envCheck.error);
    }
    chatbot = new Chatbot(process.env.PAGE_ACCESS_TOKEN!);
  }
  return chatbot;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Get client IP for rate limiting
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  
  // Check rate limit
  if (!checkRateLimit(typeof clientIp === 'string' ? clientIp : clientIp[0])) {
    return res.status(429).json({
      error: 'Too many requests',
      message: 'Please try again later'
    });
  }

  try {
    // Validate environment variables
    const envCheck = validateEnvironment();
    if (!envCheck.isValid) {
      console.error('Environment validation failed:', envCheck.error);
      return res.status(500).json({ error: envCheck.error });
    }

    // Handle webhook verification (GET request)
    if (req.method === 'GET') {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];

      if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
        console.log('Webhook verified successfully');
        return res.status(200).send(challenge);
      } else {
        console.warn('Webhook verification failed:', { mode, token });
        return res.status(403).json({ error: 'Verification failed' });
      }
    }

    // Handle webhook events (POST request)
    if (req.method === 'POST') {
      const body = req.body;

      if (body.object !== 'page') {
        return res.status(404).json({ error: 'Invalid webhook event' });
      }

      try {
        const bot = getChatbot();
        
        const responses = await Promise.all(
          body.entry.map(async (entry: any) => {
            return Promise.all(
              entry.messaging.map(async (event: any) => {
                const senderId = event.sender.id;
                
                try {
                  await bot.handleMessage(senderId, event);
                  return { senderId, status: 'success' };
                } catch (error) {
                  console.error(`Error processing message for sender ${senderId}:`, error);
                  return { 
                    senderId, 
                    status: 'error',
                    error: error instanceof Error ? error.message : 'Unknown error'
                  };
                }
              })
            );
          })
        );

        return res.status(200).json({ 
          status: 'ok',
          timestamp: new Date().toISOString(),
          responses: responses.flat()
        });
      } catch (error) {
        console.error('Error processing webhook events:', error);
        return res.status(500).json({ 
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    // Handle unsupported methods
    return res.status(405).json({ 
      error: 'Method not allowed',
      message: `Method ${req.method} is not supported`
    });

  } catch (error) {
    console.error('Unhandled error in webhook handler:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'An unexpected error occurred'
    });
  }
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb' // Limit payload size
    },
  },
};