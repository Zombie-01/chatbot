import { readFileSync } from 'fs';
import { MessengerClient, MessengerTemplate } from './messenger';

interface ChatbotNode {
  id: string;
  type: string;
  label: string;
  items: Array<{
    id: string;
    type: string;
    text?: string;
    video_url?: string;
    number?: string;
    link?: string;
    buttons?: Array<{
      id: string;
      text: string;
    }>;
  }>;
}

interface UserSession {
  currentNode: string;
  lastInteraction: Date;
  messageCount: number;
  context: Record<string, any>;
}

export class Chatbot {
  private flow: any;
  private messenger: MessengerClient;
  private userSessions: Map<string, UserSession>;
  private readonly sessionTimeout = 30 * 60 * 1000; // 30 minutes
  private readonly maxMessagesPerMinute = 20;

  constructor(pageAccessToken: string) {
    this.messenger = new MessengerClient(pageAccessToken);
    this.userSessions = new Map();
    this.loadFlow();
    this.startSessionCleanup();
  }

  private loadFlow() {
    try {
      const flowData = readFileSync('public/flow.json', 'utf8');
      this.flow = JSON.parse(flowData);
      this.validateFlow();
    } catch (error) {
      console.error('Error loading flow:', error);
      throw error;
    }
  }

  private validateFlow() {
    if (!this.flow.messages || !Array.isArray(this.flow.messages)) {
      throw new Error('Invalid flow: messages array is required');
    }
    if (!this.flow.elements?.edges || !Array.isArray(this.flow.elements.edges)) {
      throw new Error('Invalid flow: edges array is required');
    }
  }

  private findNodeById(id: string): ChatbotNode | undefined {
    return this.flow.messages.find((message: ChatbotNode) => message.id === id);
  }

  private findNextNodes(currentNodeId: string): string[] {
    return this.flow.elements.edges
      .filter((edge: any) => edge.source === currentNodeId)
      .map((edge: any) => edge.target);
  }

  private createTemplateFromNode(node: ChatbotNode): MessengerTemplate {
    if (!node.items?.[0]) {
      return {
        template_type: 'text',
        text: 'Sorry, this message is not properly configured.',
      };
    }

    const item = node.items[0];
    
    try {
      if (item.type === 'messengerTextVue') {
        if (item.buttons?.length > 0) {
          return {
            template_type: 'button',
            text: item.text || '',
            buttons: item.buttons.map(button => ({
              type: 'postback',
              title: button.text,
              payload: button.id,
            })),
          };
        } else {
          return {
            template_type: 'text',
            text: item.text || '',
          };
        }
      }

      if (item.type === 'messengerVideoVue') {
        if (item.video_url) {
          return {
            template_type: 'media',
            attachment: {
              type: 'video',
              payload: {
                url: item.video_url,
              },
            },
          };
        } else if (item.link) {
          return {
            template_type: 'generic',
            elements: [{
              title: item.number || 'Video',
              subtitle: 'Click to watch',
              default_action: {
                type: 'web_url',
                url: item.link,
              },
              buttons: [{
                type: 'web_url',
                url: item.link,
                title: 'Watch Video',
              }],
            }],
          };
        }
      }

      return {
        template_type: 'text',
        text: 'Sorry, I don\'t understand that message type.',
      };
    } catch (error) {
      console.error('Error creating template from node:', error);
      return {
        template_type: 'text',
        text: 'Sorry, I encountered an error processing this message.',
      };
    }
  }

  private getUserSession(senderId: string): UserSession {
    let session = this.userSessions.get(senderId);
    if (!session) {
      session = {
        currentNode: this.flow.messages[0].id,
        lastInteraction: new Date(),
        messageCount: 0,
        context: {},
      };
      this.userSessions.set(senderId, session);
    }
    return session;
  }

  private updateSessionActivity(session: UserSession) {
    session.lastInteraction = new Date();
    session.messageCount++;
  }

  private startSessionCleanup() {
    setInterval(() => {
      const now = Date.now();
      for (const [senderId, session] of this.userSessions.entries()) {
        if (now - session.lastInteraction.getTime() > this.sessionTimeout) {
          this.userSessions.delete(senderId);
        }
      }
    }, 5 * 60 * 1000); // Run cleanup every 5 minutes
  }

  private checkRateLimit(session: UserSession): boolean {
    const now = Date.now();
    const oneMinuteAgo = now - 60 * 1000;
    
    if (session.lastInteraction.getTime() < oneMinuteAgo) {
      session.messageCount = 0;
    }

    return session.messageCount < this.maxMessagesPerMinute;
  }

  async handleMessage(senderId: string, message: any) {
    try {
      const session = this.getUserSession(senderId);

      if (!this.checkRateLimit(session)) {
        await this.messenger.sendTemplate(senderId, {
          template_type: 'text',
          text: 'You\'re sending messages too quickly. Please wait a moment before trying again.',
        });
        return;
      }

      await this.messenger.markSeen(senderId);
      await this.messenger.typingOn(senderId);

      let nextNodeId: string | undefined;

      if (message.postback) {
        const nextNodes = this.findNextNodes(message.postback.payload);
        nextNodeId = nextNodes[0];
      } else if (message.text) {
        const currentNode = this.findNodeById(session.currentNode);
        if (currentNode?.items[0]?.buttons) {
          const matchingButton = currentNode.items[0].buttons.find(
            button => button.text.toLowerCase() === message.text.toLowerCase()
          );
          if (matchingButton) {
            const nextNodes = this.findNextNodes(matchingButton.id);
            nextNodeId = nextNodes[0];
          }
        }

        if (!nextNodeId) {
          nextNodeId = this.flow.messages[0].id;
        }
      }

      if (nextNodeId) {
        const node = this.findNodeById(nextNodeId);
        if (node) {
          session.currentNode = nextNodeId;
          const template = this.createTemplateFromNode(node);
          await this.messenger.sendTemplate(senderId, template);
        }
      }

      this.updateSessionActivity(session);
      await this.messenger.typingOff(senderId);
    } catch (error) {
      console.error('Error handling message:', error);
      await this.messenger.sendTemplate(senderId, {
        template_type: 'text',
        text: 'Sorry, I encountered an error. Please try again.',
      });
      throw error;
    }
  }
}