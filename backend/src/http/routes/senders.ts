import { Router } from 'express';
import { AppError } from '../../lib/errors';
import {
  createSender,
  CreateSenderInputSchema,
  deactivateSender,
  listSenders,
  updateSender,
  UpdateSenderInputSchema,
  verifySender,
} from '../../services/senderService';
import { asyncHandler } from '../asyncHandler';
import { authed, requireAuth } from '../middleware/auth';
import { pathParam } from '../params';

/**
 * Sender (SMTP account) routes. Every route is authenticated and every service
 * call is scoped to the caller's user id — the SMTP password is validated,
 * encrypted, and stored by the service and never travels back out in a response.
 */
export const sendersRouter: Router = Router();
sendersRouter.use(requireAuth);

sendersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { userId } = authed(req);
    res.json({ senders: await listSenders(userId) });
  }),
);

sendersRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { userId } = authed(req);
    const parsed = CreateSenderInputSchema.safeParse(req.body);
    if (!parsed.success) throw AppError.validation('Invalid sender', parsed.error.flatten());
    const sender = await createSender(userId, parsed.data);
    res.status(201).json({ sender });
  }),
);

sendersRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { userId } = authed(req);
    const parsed = UpdateSenderInputSchema.safeParse(req.body);
    if (!parsed.success) throw AppError.validation('Invalid sender update', parsed.error.flatten());
    const sender = await updateSender(userId, pathParam(req, 'id'), parsed.data);
    res.json({ sender });
  }),
);

sendersRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { userId } = authed(req);
    const sender = await deactivateSender(userId, pathParam(req, 'id'));
    res.json({ sender });
  }),
);

sendersRouter.post(
  '/:id/verify',
  asyncHandler(async (req, res) => {
    const { userId } = authed(req);
    res.json(await verifySender(userId, pathParam(req, 'id')));
  }),
);
