import { Module } from '@nestjs/common';
import { AssistController, ProviderAssistController } from './assist.controller.js';
import { AssistService } from './assist.service.js';

@Module({ controllers: [AssistController, ProviderAssistController], providers: [AssistService] })
export class AssistModule {}
