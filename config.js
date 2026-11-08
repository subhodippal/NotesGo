// App settings. Same Supabase project as myExpenses; NotesGo's tables live in the "notesgo" schema.
// The anon key is safe to publish: Row Level Security (supabase/schema.sql) protects each user's data.
// Never put the service_role key here.
window.APP_CONFIG = {
  SUPABASE_URL: 'https://knhhgslvuyiqaotlyvez.supabase.co',
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtuaGhnc2x2dXlpcWFvdGx5dmV6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5NjM0MjgsImV4cCI6MjEwNzUzOTQyOH0.XNXJ9SlMVDRGeZ_usuqU27TGHA26l-UGjHVVz4PUgQ0',
  SCHEMA: 'notesgo',
  TRASH_DAYS: 30, // notes in Trash are deleted forever after this many days (30 = 1 month)
  AUTO_LOCK_SECONDS: 60, // secure folder locks this long after the app goes to the background
};
