import axios from 'axios';

const FACEBOOK_API_URL = 'https://graph.facebook.com/v19.0/me/messages';

export interface MessengerTemplate {
  template_type: string;
  elements?: any[];
  text?: string;
  buttons?: any[];
  quick_replies?: any[];
  attachment?: {
    type: string;
    payload: {
      url?: string;
      template_type?: string;
      elements?: any[];
      text?: string;
      buttons?: any[];
    };
  };
}

export interface MessengerButton {
  type: 'web_url' | 'postback' | 'phone_number';
  title: string;
  url?: string;
  payload?: string;
  phone_number?: string;
}

export interface MessengerElement {
  title: string;
  subtitle?: string;
  image_url?: string;
  default_action?: {
    type: string;
    url: string;
  };
  buttons?: MessengerButton[];
}

export class MessengerClient {
  private pageAccessToken: string;
  private readonly maxButtonTitleLength = 20;
  private readonly maxTextLength = 2000;

  constructor(pageAccessToken: string) {
    if (!pageAccessToken) {
      throw new Error('Page Access Token is required');
    }
    this.pageAccessToken = pageAccessToken;
  }

  private validateText(text: string): string {
    if (!text) return '';
    return text.substring(0, this.maxTextLength);
  }

  private validateButtonTitle(title: string): string {
    if (!title) return '';
    return title.substring(0, this.maxButtonTitleLength);
  }

  private validateButtons(buttons: MessengerButton[]): MessengerButton[] {
    if (!buttons || !Array.isArray(buttons)) return [];
    return buttons.slice(0, 3).map(button => ({
      ...button,
      title: this.validateButtonTitle(button.title)
    }));
  }

  private validateElements(elements: MessengerElement[]): MessengerElement[] {
    if (!elements || !Array.isArray(elements)) return [];
    return elements.slice(0, 10).map(element => ({
      ...element,
      title: this.validateText(element.title),
      subtitle: element.subtitle ? this.validateText(element.subtitle) : undefined,
      buttons: element.buttons ? this.validateButtons(element.buttons) : undefined
    }));
  }

  async sendMessage(recipientId: string, message: any) {
    if (!recipientId) {
      throw new Error('Recipient ID is required');
    }

    try {
      const response = await axios.post(
        `${FACEBOOK_API_URL}?access_token=${this.pageAccessToken}`,
        {
          recipient: { id: recipientId },
          message,
        },
        {
          timeout: 5000, // 5 second timeout
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response) {
          throw new Error(`Messenger API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
          throw new Error('No response received from Messenger API');
        }
      }
      throw error;
    }
  }

  async sendTemplate(recipientId: string, template: MessengerTemplate) {
    const message: any = {};

    try {
      switch (template.template_type) {
        case 'generic':
          message.attachment = {
            type: 'template',
            payload: {
              template_type: 'generic',
              elements: this.validateElements(template.elements || []),
            },
          };
          break;

        case 'button':
          if (!template.text) {
            throw new Error('Button template requires text');
          }
          message.attachment = {
            type: 'template',
            payload: {
              template_type: 'button',
              text: this.validateText(template.text),
              buttons: this.validateButtons(template.buttons || []),
            },
          };
          break;

        case 'media':
          if (!template.attachment?.payload?.url) {
            throw new Error('Media template requires a URL');
          }
          message.attachment = template.attachment;
          break;

        case 'text':
          if (!template.text) {
            throw new Error('Text template requires text');
          }
          message.text = this.validateText(template.text);
          if (template.quick_replies) {
            message.quick_replies = template.quick_replies.slice(0, 13).map(reply => ({
              ...reply,
              title: this.validateButtonTitle(reply.title)
            }));
          }
          break;

        default:
          throw new Error(`Unsupported template type: ${template.template_type}`);
      }

      return this.sendMessage(recipientId, message);
    } catch (error) {
      console.error('Error preparing template:', error);
      // Fallback to a simple text message
      return this.sendMessage(recipientId, {
        text: 'Sorry, I encountered an error preparing the message. Please try again.',
      });
    }
  }

  async markSeen(recipientId: string) {
    try {
      await this.sendMessage(recipientId, {
        sender_action: 'mark_seen'
      });
    } catch (error) {
      console.error('Error marking message as seen:', error);
    }
  }

  async typingOn(recipientId: string) {
    try {
      await this.sendMessage(recipientId, {
        sender_action: 'typing_on'
      });
    } catch (error) {
      console.error('Error setting typing indicator:', error);
    }
  }

  async typingOff(recipientId: string) {
    try {
      await this.sendMessage(recipientId, {
        sender_action: 'typing_off'
      });
    } catch (error) {
      console.error('Error removing typing indicator:', error);
    }
  }
}