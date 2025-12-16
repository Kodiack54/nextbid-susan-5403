/**
 * Susan's Supabase Client
 * Database access for knowledge storage and retrieval
 */

const { createClient } = require('@supabase/supabase-js');
const config = require('./config');

let supabase = null;

function getClient() {
  if (!supabase) {
    supabase = createClient(
      config.SUPABASE_URL,
      config.SUPABASE_SERVICE_KEY
    );
  }
  return supabase;
}

/**
 * Helper to access tables with the Supabase client
 */
function from(table) {
  return getClient().from(table);
}

/**
 * Helper to access storage buckets
 */
function storage(bucket) {
  return getClient().storage.from(bucket);
}

module.exports = {
  getClient,
  from,
  storage
};
