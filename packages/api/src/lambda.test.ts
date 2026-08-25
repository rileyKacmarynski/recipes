import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { expect, test } from "vitest";
import { handler } from "./lambda";

test("Lambda handler serves the Hono app", async () => {
  const response = await handler(httpApiEvent("GET", "/health"), lambdaContext());

  expect(response).toMatchObject({
    statusCode: 200,
    body: JSON.stringify({ ok: true }),
  });
});

function httpApiEvent(method: string, path: string): LambdaEvent {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers: {
      host: "recipes-api.rkac.dev",
    },
    requestContext: {
      accountId: "123456789012",
      apiId: "test-api",
      authentication: null,
      authorizer: {},
      domainName: "recipes-api.rkac.dev",
      domainPrefix: "recipes-api",
      http: {
        method,
        path,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      requestId: "test-request",
      routeKey: "$default",
      stage: "$default",
      time: "01/Jan/2026:00:00:00 +0000",
      timeEpoch: 1767225600000,
    },
    body: null,
    isBase64Encoded: false,
  };
}

function lambdaContext(): LambdaContext {
  return {
    callbackWaitsForEmptyEventLoop: true,
    functionName: "recipes-prod-api",
    functionVersion: "$LATEST",
    invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:recipes-prod-api",
    memoryLimitInMB: "128",
    awsRequestId: "test-request",
    logGroupName: "/aws/lambda/recipes-prod-api",
    logStreamName: "test-stream",
    getRemainingTimeInMillis: () => 3000,
  };
}
