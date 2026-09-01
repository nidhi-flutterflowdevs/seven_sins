import "@supabase/functions-js/edge-runtime.d.ts";

console.log("Hello from Functions!");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Credentials": "true",
  "Content-Type": "application/json",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  try {
    const payload = await req.json();

    console.log(
      "Received JSON payload:",
      JSON.stringify(payload, null, 2),
    );

    if (!payload || typeof payload !== "object") {
      return new Response(
        JSON.stringify({
          error: "Invalid payload",
        }),
        {
          status: 400,
          headers: corsHeaders,
        },
      );
    }

    const title = payload.title || "Default Title";
    const content = payload.description || "Default Content";

    const oneSignalBody = {
      app_id: Deno.env.get("ONESIGNAL_APP_ID")!,

      ...(Array.isArray(payload.send_to) && payload.send_to.length > 0
        ? {
            include_external_user_ids: payload.send_to,
          }
        : {
            included_segments: ["Total Subscriptions"],
          }),

      contents: {
        en: content,
      },

      headings: {
        en: title,
      },

      data: {
        type: payload.type,
        title: payload.title,
        description: payload.description,
      },

      channel_for_external_user_ids: "push",
      big_picture: payload.image_url,
    };

    const response = await fetch(
      "https://onesignal.com/api/v1/notifications",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": Deno.env.get("ONESIGNAL_AUTH")!,
        },
        body: JSON.stringify(oneSignalBody),
      },
    );

    const responseData = await response.json();

    console.log(
      "OneSignal API Response:",
      responseData,
    );

    return new Response(
      JSON.stringify({
        message: "Payload received successfully",
        oneSignalResponse: responseData,
      }),
      {
        status: response.ok ? 200 : response.status,
        headers: corsHeaders,
      },
    );
  } catch (error) {
    console.error(
      "Error making OneSignal API request:",
      error,
    );

    return new Response(
      JSON.stringify({
        error: "Failed to process notification",
      }),
      {
        status: 500,
        headers: corsHeaders,
      },
    );
  }
});
