import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { AuthContext } from '@intitaxi/auth-verifier';
import { AccessTokenGuard, Auth, parseInput, type AppRequest } from '@intitaxi/nest-common';
import { z } from 'zod';
import { ChatService } from './chat.service.js';

@Controller('v1/trips/:tripId/chat')
@UseGuards(AccessTokenGuard)
export class ChatController {
  constructor(@Inject(ChatService) private readonly chat: ChatService) {}

  @Get()
  history(@Auth() auth: AuthContext, @Param('tripId', ParseUUIDPipe) tripId: string) {
    return this.chat.history(auth.userId, tripId);
  }

  @Post('media')
  @HttpCode(201)
  upload(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('tripId', ParseUUIDPipe) tripId: string, @Body() body: unknown) {
    const i = parseInput(z.object({ kind: z.enum(['voice', 'photo', 'video']), contentType: z.enum(['audio/mp4', 'image/jpeg', 'image/png', 'video/mp4']), size: z.number().int().positive() }), body);
    return this.chat.createUpload(auth.userId, tripId, i, req);
  }

  @Post('media/:mediaId/complete')
  @HttpCode(200)
  complete(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('tripId', ParseUUIDPipe) tripId: string, @Param('mediaId', ParseUUIDPipe) mediaId: string) {
    return this.chat.complete(auth.userId, tripId, mediaId, req);
  }

  @Get('media/:mediaId')
  media(@Auth() auth: AuthContext, @Param('tripId', ParseUUIDPipe) tripId: string, @Param('mediaId', ParseUUIDPipe) mediaId: string) {
    return this.chat.downloadUrl(auth.userId, tripId, mediaId);
  }
}
