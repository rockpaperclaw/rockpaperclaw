import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Service role client — bypasses RLS. Used for all mutations and
// any query that needs to see restricted columns (e.g. api_key_hash).
export function createServiceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
}
