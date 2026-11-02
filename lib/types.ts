/** Shared API types used by both the route handlers and the client. */

export interface ScheduledMessageDto {
  id: string;
  recipientName: string;
  phoneNumber: string;
  messageContent: string;
  status: string;
  scheduledAt: string;
  scheduledAtLocal: { date: string; time: string };
  scheduledAtLabel: string;
  timezone: string;
}

export interface CreateMessageResponse {
  message: ScheduledMessageDto;
}

export interface ApiError {
  error: string;
  fields?: Record<string, string>;
  messageId?: string;
}

export interface MessageListItem {
  id: string;
  recipientName: string;
  phoneNumber: string;
  status: string;
  scheduledAtLabel: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failureReason: string | null;
}

export interface ListMessagesResponse {
  timezone: string;
  count: number;
  messages: MessageListItem[];
}
