// VaultPay SDK Type Definitions

export interface VaultPayOptions {
  baseUrl?: string;
  timeout?: number;
}

export interface Customer {
  name: string;
  email: string;
  phone: string;
}

export interface CreatePaymentParams {
  order_id: string;
  amount: number;
  currency?: 'INR' | 'USD' | 'EUR' | 'GBP' | 'AED';
  customer: Customer;
  description?: string;
  payment_method?: 'upi' | 'card' | 'net_banking' | 'wallet' | 'qr';
  metadata?: Record<string, string | number | boolean>;
  callback_url?: string;
  redirect_url?: string;
  expires_in?: number;
}

export interface PaymentResponse {
  payment_id: string;
  order_id: string;
  amount: number;
  amount_formatted: string;
  currency: string;
  status: 'created' | 'processing' | 'captured' | 'failed' | 'refunded' | 'expired';
  qr_code: string;
  gateway_url: string;
  expires_at: string;
  merchant: { name: string; brand_color: string; logo_url: string; };
}

export interface ParsedSMS {
  type: 'credit' | 'debit' | null;
  amount: number | null;
  transaction_id: string | null;
  bank: string | null;
  account: string | null;
}

export interface SMSParseResponse {
  parsed: ParsedSMS;
  matched_payment: { id: string; order_id: string; amount: number; } | null;
  action_taken: 'captured' | 'auto_captured' | 'already_processed' | 'amount_mismatch' | 'match_requires_confirmation' | null;
}

export class VaultPayError extends Error {
  code: string;
  statusCode: number;
  raw: unknown;
}

export class VaultPay {
  constructor(apiKey: string, options?: VaultPayOptions);

  readonly isLiveMode: boolean;
  readonly isTestMode: boolean;

  payments: {
    create(params: CreatePaymentParams): Promise<PaymentResponse>;
    fetch(paymentId: string): Promise<PaymentResponse>;
    capture(paymentId: string, amount?: number): Promise<{ payment_id: string; status: string; captured_at: string; }>;
    refund(paymentId: string): Promise<{ payment_id: string; status: string; refunded_at: string; }>;
    list(limit?: number): Promise<{ payments: PaymentResponse[]; count: number; }>;
  };

  qr: {
    generate(text: string, options?: { width?: number; dark_color?: string; light_color?: string; }): Promise<{ qr_code: string; }>;
  };

  sms: {
    parse(smsText: string, paymentId?: string): Promise<SMSParseResponse>;
  };

  static verifyWebhookSignature(rawBody: string | Buffer, signature: string, secret: string): boolean;
}

export default VaultPay;
