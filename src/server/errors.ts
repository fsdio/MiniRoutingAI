// src/server/errors.ts

export function openAIError(
  message: string,
  type: string = "invalid_request_error",
  code: string | null = null,
  param: string | null = null,
) {
  return {
    error: {
      message,
      type,
      code,
      param,
    },
  };
}

export function jsonErrorResponse(
  message: string,
  status: number,
  type?: string,
  code?: string | null,
): Response {
  const body = openAIError(message, type, code ?? null);
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
