import type { Application, Request, Response } from 'express';
import { UsageLimitsService } from './usage-limits-service';

export function installUsageLimitsRoutes(
  app: Application,
  service = new UsageLimitsService(),
): void {
  app.get('/api/insights/usage-limits', async (req: Request, res: Response) => {
    try {
      const rawRefresh = typeof req.query.refresh === 'string' ? req.query.refresh.trim().toLowerCase() : '';
      const refresh = rawRefresh === '1' || rawRefresh === 'true';
      const payload = await service.getUsageLimits({ refresh });
      res.json(payload);
    } catch (error: any) {
      res.status(error?.status || error?.statusCode || 500).json({
        error: error?.message || 'Failed to fetch usage limits',
      });
    }
  });
}
