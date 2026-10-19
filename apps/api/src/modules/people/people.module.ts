import { Global, Module } from '@nestjs/common';
import { PeopleController, SubjectPortalController } from './people.controller.js';
import { PeopleService } from './people.service.js';

@Global()
@Module({ controllers: [PeopleController, SubjectPortalController], providers: [PeopleService], exports: [PeopleService] })
export class PeopleModule {}
