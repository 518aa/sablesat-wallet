export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletError";
  }
}

export class InsufficientBalanceError extends WalletError {
  constructor(public required: number, public available: number) {
    super(`Insufficient balance: need ${required} sats, have ${available} sats`);
    this.name = "InsufficientBalanceError";
  }
}

export class NetworkError extends WalletError {
  constructor(public readonly cause: Error) {
    super(`Network error: ${cause.message}`);
    this.name = "NetworkError";
  }
}

export class TransactionValidationError extends WalletError {
  constructor(message: string) {
    super(message);
    this.name = "TransactionValidationError";
  }
}

export class SelfSendError extends WalletError {
  constructor() {
    super("Cannot send to your own address");
    this.name = "SelfSendError";
  }
}

export class InvalidAddressError extends WalletError {
  constructor(address: string) {
    super(`Invalid Bitcoin address: ${address}`);
    this.name = "InvalidAddressError";
  }
}
