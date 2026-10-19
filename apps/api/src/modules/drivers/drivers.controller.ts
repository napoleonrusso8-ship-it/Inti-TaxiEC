import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { AuthContext } from '@intitaxi/auth-verifier';
import { AccessTokenGuard, AppError, AttestationGuard, Auth, parseInput, type AppRequest } from '@intitaxi/nest-common';
import type { Response } from 'express';
import { z } from 'zod';
import { ALLOWED_CONTENT_TYPES, MAX_DOCUMENT_BYTES } from '../../infra/file-inspection.js';
import { LocalStorage, type StoragePort } from '../../infra/storage.js';
import { STORAGE } from '../../tokens.js';
import { AdminGuard, AdminRoles, AdminWrite } from '../admin/admin.guard.js';
import { DriversService } from './drivers.service.js';
import { PROFESSIONAL_LICENSE_CATEGORIES } from './eligibility.js';

const DRIVER_CLIENT = 'intitaxi-driver';
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const requireDriverApp = (auth: AuthContext) => {
  if (auth.clientId !== DRIVER_CLIENT) throw new AppError(403, 'forbidden', 'Usa la app de conductor');
};

@Controller('v1/driver')
@UseGuards(AccessTokenGuard, AttestationGuard)
export class DriverController {
  constructor(@Inject(DriversService) private readonly drivers: DriversService) {}

  @Post('application')
  @HttpCode(201)
  apply(@Req() req: AppRequest, @Auth() auth: AuthContext, @Body() body: unknown) {
    requireDriverApp(auth);
    const input = parseInput(
      z.object({ licenseNumber: z.string().min(6).max(20).regex(/^[A-Za-z0-9 -]+$/), licenseCategory: z.enum(PROFESSIONAL_LICENSE_CATEGORIES as [string, ...string[]]), licenseExpiresOn: isoDate }),
      body,
    );
    return this.drivers.apply(auth.userId, input, req);
  }

  @Get('profile')
  profile(@Auth() auth: AuthContext) {
    requireDriverApp(auth);
    return this.drivers.view(auth.userId);
  }

  @Post('vehicles')
  @HttpCode(201)
  vehicle(@Req() req: AppRequest, @Auth() auth: AuthContext, @Body() body: unknown) {
    requireDriverApp(auth);
    const v = parseInput(
      z.object({
        plate: z.string().max(10),
        make: z.string().min(2).max(40).regex(/^[\p{L}\p{N} .-]+$/u),
        model: z.string().min(1).max(40).regex(/^[\p{L}\p{N} .-]+$/u),
        year: z.number().int().min(1980).max(new Date().getFullYear() + 1),
        color: z.string().min(3).max(30).regex(/^[\p{L} ]+$/u),
        seats: z.number().int().min(1).max(8),
      }),
      body,
    );
    return this.drivers.addVehicle(auth.userId, v, req);
  }

  @Post('documents/upload-url')
  @HttpCode(201)
  uploadUrl(@Req() req: AppRequest, @Auth() auth: AuthContext, @Body() body: unknown) {
    requireDriverApp(auth);
    const d = parseInput(
      z.object({
        type: z.enum(['license', 'background_check', 'registration', 'insurance']),
        vehicleId: z.string().uuid().optional(),
        contentType: z.enum(ALLOWED_CONTENT_TYPES as [string, ...string[]]),
        size: z.number().int().min(1).max(MAX_DOCUMENT_BYTES),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        expiresOn: isoDate.optional(),
      }),
      body,
    );
    return this.drivers.createUpload(auth.userId, d, req);
  }

  @Post('documents/:id/complete')
  @HttpCode(200)
  complete(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    requireDriverApp(auth);
    return this.drivers.completeUpload(auth.userId, id, req);
  }

  @Post('application/submit')
  @HttpCode(200)
  submit(@Req() req: AppRequest, @Auth() auth: AuthContext) {
    requireDriverApp(auth);
    return this.drivers.submit(auth.userId, req);
  }
}

@Controller('v1/admin/drivers')
@UseGuards(AccessTokenGuard, AdminGuard)
@AdminRoles('driver_reviewer')
export class AdminDriversController {
  constructor(@Inject(DriversService) private readonly drivers: DriversService) {}

  @Get()
  queue(@Query('status') status = 'under_review') {
    return this.drivers.queue(parseInput(z.enum(['applicant', 'under_review', 'approved', 'rejected', 'suspended']), status));
  }

  @Get(':id')
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    return { driverId: id, ...(await this.drivers.view(id)), issuesForApproval: await this.drivers.eligibility(id, { forApproval: true }) };
  }

  /** URL de 60 s; el motivo queda en la auditoría. */
  @Post(':id/documents/:docId/view-url')
  @HttpCode(200)
  viewUrl(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string, @Body() body: unknown) {
    const { reason } = parseInput(z.object({ reason: z.string().min(10).max(300) }), body);
    return this.drivers.documentViewUrl(auth.userId, id, docId, reason, req);
  }

  @Post(':id/documents/:docId/review')
  @HttpCode(200)
  @AdminWrite()
  review(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string, @Body() body: unknown) {
    const { decision, reason } = parseInput(z.object({ decision: z.enum(['approved', 'rejected']), reason: z.string().max(300).optional() }), body);
    return this.drivers.reviewDocument(auth.userId, id, docId, decision, reason, req);
  }

  @Post(':id/decision')
  @HttpCode(200)
  @AdminWrite()
  decide(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { decision, reason } = parseInput(z.object({ decision: z.enum(['approve', 'reject', 'suspend']), reason: z.string().min(3).max(300) }), body);
    return this.drivers.decide(auth.userId, id, decision, reason, req);
  }
}

/** SOLO DESARROLLO: subida/descarga para LocalStorage con URLs firmadas por HMAC (equivalente local de S3). */
@Controller('v1/dev/storage')
export class DevStorageController {
  constructor(@Inject(STORAGE) private readonly storage: StoragePort) {}

  @Get()
  async get(@Query() q: Record<string, string>, @Res() res: Response) {
    const s = this.storage;
    if (!(s instanceof LocalStorage) || !s.verify('get', q.key ?? '', Number(q.exp), q.sig ?? '')) throw new AppError(403, 'forbidden');
    const data = await s.read(q.key!, MAX_DOCUMENT_BYTES);
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.send(data);
  }
}
