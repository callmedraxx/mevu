import { Router } from 'express';
import logosRouter from './logos';

const router = Router();

/**
 * @swagger
 * /api:
 *   get:
 *     summary: API information
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: API information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: MEVU API v1.0.0
 */
router.get('/', (req, res) => {
  res.json({
    message: 'MEVU API v1.0.0',
  });
});

// Logo routes
router.use('/logos', logosRouter);

export default router;

