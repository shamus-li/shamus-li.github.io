import { accessErrorResponse, requireAccess } from "../_lib/access.js";

export async function onRequest(context) {
  try {
    await requireAccess(context);
  } catch (err) {
    return accessErrorResponse(err, context.request);
  }

  return context.next();
}
