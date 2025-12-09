/**
 * Injected URLs Service
 * Manages URLs that should be injected into event responses
 */

import { logger } from '../../config/logger';

export interface InjectedUrl {
  id: string;
  url: string;
  path: string;
  params?: Record<string, any>;
  title?: string;
  category?: string;
  addedAt: Date;
}

class InjectedUrlsService {
  private urls: Map<string, InjectedUrl> = new Map();

  /**
   * Add a URL to be injected
   */
  addUrl(
    id: string, 
    url: string, 
    path: string, 
    params?: Record<string, any>,
    title?: string, 
    category?: string
  ): void {
    this.urls.set(id, {
      id,
      url,
      path,
      params,
      title,
      category,
      addedAt: new Date(),
    });
    logger.info({ message: 'Added injected URL', id, url, path });
  }

  /**
   * Remove a URL
   */
  removeUrl(id: string): boolean {
    const deleted = this.urls.delete(id);
    if (deleted) {
      logger.info({ message: 'Removed injected URL', id });
    }
    return deleted;
  }

  /**
   * Get a specific URL
   */
  getUrl(id: string): InjectedUrl | undefined {
    return this.urls.get(id);
  }

  /**
   * Get all injected URLs
   */
  getAllUrls(): InjectedUrl[] {
    return Array.from(this.urls.values());
  }

  /**
   * Get URLs by category
   */
  getUrlsByCategory(category: string): InjectedUrl[] {
    return this.getAllUrls().filter(u => u.category === category);
  }

  /**
   * Clear all URLs
   */
  clearAll(): void {
    this.urls.clear();
    logger.info({ message: 'Cleared all injected URLs' });
  }
}

export const injectedUrlsService = new InjectedUrlsService();
