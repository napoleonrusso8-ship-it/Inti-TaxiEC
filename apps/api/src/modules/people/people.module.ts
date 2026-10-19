import { Global, Module } from '@nestjs/common';
import { PeopleController } from './people.controller.js';
import { PeopleService } from './people.service.js';

@Global()
@Module({ controllers: [PeopleController], providers: [PeopleService], exports: [PeopleService] })
export class PeopleModule {}
