export const handler = async () => ({
  statusCode: 503,
  headers: {
    "content-type": "application/json",
  },
  body: JSON.stringify({
    error: "API artifact has not been deployed yet",
  }),
});
