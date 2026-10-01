import { ProblemSchema } from "@pantau/contracts";

export const errorResponses = {
  400: ProblemSchema,
  401: ProblemSchema,
  403: ProblemSchema,
  404: ProblemSchema,
  422: ProblemSchema,
  502: ProblemSchema,
  504: ProblemSchema,
} as const;
