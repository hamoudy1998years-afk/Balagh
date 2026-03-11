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
    // 1. Create a regular client to verify the calling user's JWT
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization")! } } }
    );

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = user.id;

    // 2. Create an admin client with the service role key to delete everything
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 3. Delete all user data in order (children before parents)
    const tablesToClean = [
      { table: "comments",      column: "user_id" },
      { table: "likes",         column: "user_id" },
      { table: "follows",       column: "follower_id" },
      { table: "follows",       column: "following_id" },
      { table: "blocks",        column: "blocker_id" },
      { table: "blocks",        column: "blocked_id" },
      { table: "live_streams",  column: "user_id" },
      { table: "videos",        column: "user_id" },
      { table: "profiles",      column: "id" },          // 'id' matches auth.users.id
    ];

    for (const { table, column } of tablesToClean) {
      const { error } = await adminClient
        .from(table)
        .delete()
        .eq(column, userId);

      if (error) {
        console.error(`Error deleting from ${table}:`, error.message);
        // Log but continue — don't block auth deletion over a missing table
      }
    }

    // 4. Delete videos from Storage bucket (if you store them in Supabase Storage)
    const { data: videoFiles } = await adminClient
      .storage
      .from("videos")                          // 🔁 replace with your bucket name
      .list(userId);                           // assumes files are stored under userId/

    if (videoFiles && videoFiles.length > 0) {
      const filePaths = videoFiles.map((f) => `${userId}/${f.name}`);
      await adminClient.storage.from("videos").remove(filePaths);
    }

    // 5. Delete the Supabase Auth user — this is the step only service role can do
    const { error: deleteAuthError } = await adminClient.auth.admin.deleteUser(userId);
    if (deleteAuthError) {
      throw new Error(`Auth deletion failed: ${deleteAuthError.message}`);
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});