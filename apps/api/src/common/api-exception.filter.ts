import {
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
  type ArgumentsHost,
} from "@nestjs/common";
import { ZodError } from "zod";

import { DevflowError } from "@devflow/shared";

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status(code: number): { json(body: unknown): void };
    }>();
    if (error instanceof HttpException) {
      response.status(error.getStatus()).json(error.getResponse());
      return;
    }
    if (error instanceof ZodError) {
      response.status(HttpStatus.BAD_REQUEST).json({
        code: "VALIDATION_ERROR",
        message: "Request validation failed.",
        issues: error.issues,
      });
      return;
    }
    if (error instanceof DevflowError) {
      response.status(statusFor(error)).json(error.toJSON());
      return;
    }
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: "INTERNAL_ERROR",
      message: "Unexpected API error.",
    });
  }
}

function statusFor(error: DevflowError): number {
  switch (error.code) {
    case "VALIDATION_ERROR":
      return HttpStatus.BAD_REQUEST;
    case "NOT_FOUND":
      return HttpStatus.NOT_FOUND;
    case "CONFLICT":
      return HttpStatus.CONFLICT;
    case "PERMISSION_DENIED":
      return HttpStatus.FORBIDDEN;
    case "APPROVAL_REQUIRED":
      return HttpStatus.PRECONDITION_REQUIRED;
    case "TIMEOUT":
      return HttpStatus.GATEWAY_TIMEOUT;
    default:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}
