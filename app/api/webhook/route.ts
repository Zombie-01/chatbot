import { Chatbot } from '@/lib/chatbot';
import { NextRequest, NextResponse } from 'next/server';

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
  for (const [key, data] of ipRequests.entries() as any) {
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

// Handle GET (Webhook verification)
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verified successfully');
    return new NextResponse(challenge, { status: 200 });
  } else {
    console.warn('Webhook verification failed:', { mode, token });
    return NextResponse.json({ error: 'Verification failed' }, { status: 403 });
  }
}

// Handle POST (Webhook events)
export async function POST(req: NextRequest) {
  // Get client IP for rate limiting
  const clientIp = req.headers.get('x-forwarded-for') || req.ip || 'unknown';
  
  // Check rate limit
  if (!checkRateLimit(clientIp)) {
    return NextResponse.json({
      error: 'Too many requests',
      message: 'Please try again later'
    }, { status: 429 });
  }

  try {
    // Validate environment variables
    const envCheck = validateEnvironment();
    if (!envCheck.isValid) {
      console.error('Environment validation failed:', envCheck.error);
      return NextResponse.json({ error: envCheck.error }, { status: 500 });
    }

    const body = await req.json();

    if (body.object !== 'page') {
      return NextResponse.json({ error: 'Invalid webhook event' }, { status: 404 });
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

      return NextResponse.json({ 
        status: 'ok',
        timestamp: new Date().toISOString(),
        responses: responses.flat()
      }, { status: 200 });

    } catch (error) {
      console.error('Error processing webhook events:', error);
      return NextResponse.json({ 
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      }, { status: 500 });
    }

  } catch (error) {
    console.error('Unhandled error in webhook handler:', error);
    return NextResponse.json({ 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'An unexpected error occurred'
    }, { status: 500 });
  }
}

