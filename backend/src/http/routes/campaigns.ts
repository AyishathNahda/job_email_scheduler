import { Router } from 'express';
import { AppError } from '../../lib/errors';
import {
  cancelCampaign,
  createCampaign,
  CreateCampaignInputSchema,
  getCampaign,
  getCampaignJobs,
  getJobById,
  listAllJobs,
  ListAllJobsQuerySchema,
  listCampaigns,
  ListCampaignsQuerySchema,
  ListJobsQuerySchema,
} from '../../services/campaignService';
import { asyncHandler } from '../asyncHandler';
import { authed, requireAuth } from '../middleware/auth';
import { pathParam } from '../params';

/**
 * Campaign routes: create, list (paginated), detail, per-recipient jobs
 * (paginated + filterable), and cancel. Authenticated; every service call is
 * user-scoped. The request body/query is always re-validated with the same Zod
 * schema the service trusts — the client's validation is never relied upon.
 */
export const campaignsRouter: Router = Router();
campaignsRouter.use(requireAuth);

campaignsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { userId } = authed(req);

    // The idempotency key may arrive as an Idempotency-Key header; fold it into
    // the body so a single schema validates the whole request.
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const headerKey = req.headers['idempotency-key'];
    const body =
      typeof headerKey === 'string' && rawBody.idempotencyKey === undefined
        ? { ...rawBody, idempotencyKey: headerKey }
        : rawBody;

    const parsed = CreateCampaignInputSchema.safeParse(body);
    if (!parsed.success) throw AppError.validation('Invalid campaign', parsed.error.flatten());

    const result = await createCampaign(userId, parsed.data);
    // 200 when an idempotent replay returned the existing campaign, else 201.
    res.status(result.deduplicated ? 200 : 201).json({ campaign: result });
  }),
);

campaignsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { userId } = authed(req);
    const parsed = ListCampaignsQuerySchema.safeParse(req.query);
    if (!parsed.success) throw AppError.validation('Invalid query', parsed.error.flatten());
    res.json(await listCampaigns(userId, parsed.data));
  }),
);

campaignsRouter.get(
  '/jobs',
  asyncHandler(async (req, res) => {
    const { userId } = authed(req);
    const parsed = ListAllJobsQuerySchema.safeParse(req.query);
    if (!parsed.success) throw AppError.validation('Invalid query', parsed.error.flatten());
    res.json(await listAllJobs(userId, parsed.data));
  }),
);

campaignsRouter.get(
  '/jobs/:jobId',
  asyncHandler(async (req, res) => {
    const { userId } = authed(req);
    res.json({ job: await getJobById(userId, pathParam(req, 'jobId')) });
  }),
);


campaignsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { userId } = authed(req);
    res.json({ campaign: await getCampaign(userId, pathParam(req, 'id')) });
  }),
);

campaignsRouter.get(
  '/:id/jobs',
  asyncHandler(async (req, res) => {
    const { userId } = authed(req);
    const parsed = ListJobsQuerySchema.safeParse(req.query);
    if (!parsed.success) throw AppError.validation('Invalid query', parsed.error.flatten());
    res.json(await getCampaignJobs(userId, pathParam(req, 'id'), parsed.data));
  }),
);

campaignsRouter.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const { userId } = authed(req);
    res.json({ campaign: await cancelCampaign(userId, pathParam(req, 'id')) });
  }),
);
