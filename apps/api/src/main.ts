import "reflect-metadata";

import { NestFactory } from "@nestjs/core";

import { AppModule } from "./app.module.js";
import { ApiExceptionFilter } from "./common/api-exception.filter.js";
import { loadApiEnvironment } from "./config/env.js";

async function bootstrap(): Promise<void> {
  const environment = loadApiEnvironment();
  const app = await NestFactory.create(AppModule.register(), { forceCloseConnections: true });

  app.setGlobalPrefix("api/v1");
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableCors({ origin: environment.CORS_ORIGINS, credentials: true });
  app.enableShutdownHooks();

  await app.listen(environment.API_PORT, "0.0.0.0");
  console.info(`DevFlow API listening on http://localhost:${environment.API_PORT}/api/v1`);
}

await bootstrap();
