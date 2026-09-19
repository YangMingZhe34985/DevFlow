import { Module } from "@nestjs/common";

import { RepositoriesController } from "./repositories.controller.js";

@Module({ controllers: [RepositoriesController] })
export class RepositoriesModule {}
