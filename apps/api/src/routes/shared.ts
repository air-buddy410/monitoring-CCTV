import { ProblemSchema } from "@pantau/contracts";
import { z } from "zod";

/** 204 responses carry no body; the schema documents the status in OpenAPI. */
export const noContent = z.null().describe("No content");

export const errorResponses = {
  400: ProblemSchema,
  401: ProblemSchema,
  403: ProblemSchema,
  404: ProblemSchema,
  422: ProblemSchema,
  429: ProblemSchema,
  502: ProblemSchema,
  504: ProblemSchema,
} as const;
