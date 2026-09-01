import "jsr:@supabase/functions-js/edge-runtime.d.ts"

console.log("Hello from Functions!")
const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // Allow all origins (change for security)
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Credentials": "true",
  "Content-Type": "application/json",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  const payload = await req.json();
  
  // Log the entire JSON payload
  console.log("Received JSON payload:", JSON.stringify(payload, null, 2));

  // Ensure that payload.record exists
  if (payload) {
    // Use payload.record.title and payload.record.content if present
    const title = payload.title || "Default Title";
    const content = payload.description || "Default Content";

    // Construct the OneSignal notification body using payload data
    const oneSignalBody = {
      app_id: Deno.env.get("ONESIGNAL_APP_ID")!, // Include your app_id
      // include_external_user_ids: payload.send_to,
      // included_segments: ["Total Subscriptions"],
      ...(Array.isArray(payload.send_to) && payload.send_to.length > 0
        ? { include_external_user_ids: payload.send_to } // Use `send_to` if provided
        : { included_segments: ["Total Subscriptions"] }), // Fallback to default
      contents: {
        en: content, 
      },
      headings: {
        en: title, // Use payload title as the notification heading
      },      
      data: {
        type: payload.type,
        title: payload.title,
        description: payload.description,
        // Add more fields as needed
      },
      channel_for_external_user_ids: "push",
      big_picture: payload.image_url, // Add image URL for the notification
    };

    // Now, let's make the request to OneSignal
    try {
      const response = await fetch("https://onesignal.com/api/v1/notifications", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": Deno.env.get("ONESIGNAL_AUTH")!
        },
        body: JSON.stringify(oneSignalBody)
      });

      const responseData = await response.json();
      console.log("OneSignal API Response:", responseData);

      const data = {
        message: "Payload received successfully",
        oneSignalResponse: responseData
      };

      return new Response(
        JSON.stringify(data),
        { headers: corsHeaders },
      );
    } catch (error) {
      console.error("Error making OneSignal API request:", error);

      const errorMessage = {
        error: "Failed to send notification to OneSignal"
      };

      return new Response(
        JSON.stringify(errorMessage),
        {headers: corsHeaders}
      );
    }
  } else {
    // Handle the case where payload.record is not present
    console.error("Payload is missing the 'record' field");
    // You might want to return an error response or handle it as appropriate for your use case
  }
});