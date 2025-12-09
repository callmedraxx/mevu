/**
 * Simple logger utility
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogData {
  message: string;
  [key: string]: any;
}

class Logger {
  private log(level: LogLevel, data: LogData): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${data.message}`;
    
    console.log(logMessage, data);
  }

  info(data: LogData): void {
    this.log('info', data);
  }

  warn(data: LogData): void {
    this.log('warn', data);
  }

  error(data: LogData): void {
    this.log('error', data);
  }

  debug(data: LogData): void {
    if (process.env.NODE_ENV === 'development') {
      this.log('debug', data);
    }
  }
}

export const logger = new Logger();

