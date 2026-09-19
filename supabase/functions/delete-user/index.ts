import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Verify the calling user's JWT
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: {
          headers: {
            Authorization: req.headers.get("Authorization")!,
          },
        },
      }
    );

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();

    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      });
    }

    const userId = user.id;

    // 2. Create admin client
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 3. Delete the user's normal-video storage files via the Railway
    //    API BEFORE touching any database rows. If this fails, the whole
    //    account stays fully intact so the user can retry.
    //
    //    Requires the RAILWAY_SERVER_URL secret (e.g.
    //    `supabase secrets set RAILWAY_SERVER_URL=https://...`).
    const railwayBaseUrl = Deno.env.get("RAILWAY_SERVER_URL");

    if (!railwayBaseUrl) {
      throw new Error("RAILWAY_SERVER_URL is not configured");
    }

    const cleanupResponse = await fetch(
      `${railwayBaseUrl}/api/videos/account/${userId}/cleanup-videos`,
      {
        method: "POST",
        headers: {
          Authorization: req.headers.get("Authorization")!,
        },
      }
    );

    if (!cleanupResponse.ok) {
      console.error(
        "Video storage cleanup failed with status:",
        cleanupResponse.status
      );

      return new Response(
        JSON.stringify({
          error:
            "Could not remove all video files. Please try again.",
        }),
        {
          status: 502,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    // 4. Delete user-owned database data.
    //
    // Active livestream child tables already use ON DELETE CASCADE.
    // The separate "livestreams" replay table does NOT have an FK
    // cascade to profiles, so it must be explicitly deleted here.
    const tablesToClean = [
      { table: "comments", column: "user_id" },
      { table: "likes", column: "user_id" },

      { table: "follows", column: "follower_id" },
      { table: "follows", column: "following_id" },

      { table: "blocks", column: "blocker_id" },
      { table: "blocks", column: "blocked_id" },

      // Recorded/replay livestreams
      { table: "livestreams", column: "user_id" },

      // Active livestreams; child livestream rows cascade automatically
      { table: "live_streams", column: "user_id" },

      // Normal videos are already cleaned AND deleted row-by-row by the
      // Railway cleanup call above. Only livestream replay rows may remain
      // in the videos table here — delete those explicitly below.

      // Keep profile last
      { table: "profiles", column: "id" },
    ];

    for (const { table, column } of tablesToClean) {
      const { error } = await adminClient
        .from(table)
        .delete()
        .eq(column, userId);

      if (error) {
        console.error(
          `Error deleting from ${table}.${column}:`,
          error.message
        );

        // Do not delete the Auth account if required data cleanup failed.
        throw new Error(
          `Account data cleanup failed while deleting ${table}`
        );
      }
    }

    // Livestream replay rows in the videos table (the Railway cleanup above
    // deliberately does not touch them). This preserves the pre-existing
    // behavior of removing replay rows on account deletion without
    // re-deleting normal-video rows Railway already handled.
    const { error: replayError } = await adminClient
      .from("videos")
      .delete()
      .eq("user_id", userId)
      .eq("type", "livestream");

    if (replayError) {
      console.error(
        "Error deleting livestream replay rows:",
        replayError.message
      );

      // Do not delete the Auth account if required data cleanup failed.
      throw new Error(
        "Account data cleanup failed while deleting livestream replays"
      );
    }

    // 5. Delete Supabase Auth user only after cleanup succeeds
    const { error: deleteAuthError } =
      await adminClient.auth.admin.deleteUser(userId);

    if (deleteAuthError) {
      throw new Error(
        `Auth deletion failed: ${deleteAuthError.message}`
      );
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Account deletion failed";

    console.error("Delete account failed:", message);

    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }
});