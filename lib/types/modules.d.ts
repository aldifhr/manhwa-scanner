declare module 'discord-interactions' {
  export enum InteractionType {
    PING = 1,
    APPLICATION_COMMAND = 2,
    MESSAGE_COMPONENT = 3,
    APPLICATION_COMMAND_AUTOCOMPLETE = 4,
    MODAL_SUBMIT = 5
  }
  export enum InteractionResponseType {
    PONG = 1,
    CHANNEL_MESSAGE_WITH_SOURCE = 4,
    DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5,
    DEFERRED_UPDATE_MESSAGE = 6,
    UPDATE_MESSAGE = 7,
    APPLICATION_COMMAND_AUTOCOMPLETE_RESULT = 8,
    MODAL = 9
  }
  export function verifyKey(rawBody: string | Buffer, signature: string, timestamp: string, publicKey: string): Promise<boolean>;
}

declare module '@vercel/functions' {
  export function waitUntil(promise: Promise<any>): void;
}

declare module 'bottleneck' {
  interface ConstructorOptions {
    maxConcurrent?: number;
    minTime?: number;
    [key: string]: any;
  }
  class Bottleneck {
    constructor(options?: ConstructorOptions);
    schedule<T>(fn: () => Promise<T>): Promise<T>;
    wrap<T extends (...args: any[]) => any>(fn: T): T;
  }
  export default Bottleneck;
}

declare module 'p-limit' {
  export default function pLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T>;
}

declare module 'pino' {
  export interface Bindings { [key: string]: any; }
  export type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  export interface Logger {
    level: string;
    fatal(msg: string): void;
    fatal(obj: object, msg?: string): void;
    error(msg: string): void;
    error(obj: object, msg?: string): void;
    warn(msg: string): void;
    warn(obj: object, msg?: string): void;
    info(msg: string): void;
    info(obj: object, msg?: string): void;
    debug(msg: string): void;
    debug(obj: object, msg?: string): void;
    trace(msg: string): void;
    trace(obj: object, msg?: string): void;
    child(bindings: Bindings): Logger;
    [key: string]: any;
  }

  const pino: {
    (options?: any): Logger;
    stdSerializers: {
      err: (err: any) => any;
      req: (req: any) => any;
      res: (res: any) => any;
    };
    levels: {
      values: { [key: string]: number };
      labels: { [key: number]: string };
    };
  };

  export default pino;
}


