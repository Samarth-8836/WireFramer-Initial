import { describeActiveConfig } from "@core/llm/providers";

export async function GET() {
  return Response.json({
    status: "ok",
    llm: describeActiveConfig(),
  });
}
