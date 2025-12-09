/**
 * Logo serving routes
 * Serves logos by league and abbreviation
 */

import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../config/logger';
import { logoMappingService } from '../services/espn/logo-mapping.service';

const router = Router();

/**
 * @swagger
 * /api/logos/{league}/{abbreviation}.{ext}:
 *   get:
 *     summary: Get team logo by abbreviation
 *     tags: [Logos]
 *     parameters:
 *       - in: path
 *         name: league
 *         required: true
 *         schema:
 *           type: string
 *         description: League abbreviation (e.g., nfl, nba)
 *       - in: path
 *         name: abbreviation
 *         required: true
 *         schema:
 *           type: string
 *         description: Team abbreviation (e.g., KC, LAL)
 *       - in: path
 *         name: ext
 *         required: true
 *         schema:
 *           type: string
 *           enum: [png, jpg, jpeg, svg]
 *         description: Image file extension
 *     responses:
 *       200:
 *         description: Logo image
 *         content:
 *           image/png:
 *             schema:
 *               type: string
 *               format: binary
 *           image/jpeg:
 *             schema:
 *               type: string
 *               format: binary
 *           image/svg+xml:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Logo not found
 */
router.get('/:league/:filename', async (req: Request, res: Response) => {
  try {
    const { league, filename } = req.params;
    
    // Validate filename format (abbreviation.ext)
    const match = filename.match(/^([A-Z0-9]+)\.(png|jpg|jpeg|svg)$/i);
    if (!match) {
      return res.status(400).json({
        error: 'Invalid filename format. Expected: {abbreviation}.{ext}',
      });
    }

    const [, abbreviation, ext] = match;
    const normalizedAbbreviation = abbreviation.toUpperCase();
    const normalizedLeague = league.toLowerCase();

    // Get logo file path from mapping
    const logoPath = logoMappingService.getLogoFilePath(normalizedLeague, normalizedAbbreviation);
    
    if (!logoPath) {
      logger.warn({
        message: 'Logo not found in mapping',
        league: normalizedLeague,
        abbreviation: normalizedAbbreviation,
      });
      
      return res.status(404).json({
        error: 'Logo not found',
        league: normalizedLeague,
        abbreviation: normalizedAbbreviation,
      });
    }

    try {
      // Check if file exists
      await fs.access(logoPath);
      
      // Determine content type
      const contentType = ext.toLowerCase() === 'svg' 
        ? 'image/svg+xml' 
        : ext.toLowerCase() === 'png' 
        ? 'image/png' 
        : 'image/jpeg';

      // Read and send file
      const fileBuffer = await fs.readFile(logoPath);
      
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
      res.send(fileBuffer);
    } catch (error) {
      logger.warn({
        message: 'Logo file not found on disk',
        league: normalizedLeague,
        abbreviation: normalizedAbbreviation,
        logoPath,
      });
      
      res.status(404).json({
        error: 'Logo file not found',
        league: normalizedLeague,
        abbreviation: normalizedAbbreviation,
      });
    }
  } catch (error) {
    logger.error({
      message: 'Error serving logo',
      error: error instanceof Error ? error.message : String(error),
      params: req.params,
    });
    
    res.status(500).json({
      error: 'Internal server error',
    });
  }
});

export default router;
