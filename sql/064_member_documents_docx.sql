-- Add Member: the RSBSA Enrollment Client's Copy and the applicant's valid ID
-- may also be a Word document (.docx). The private member-documents bucket
-- accepts that type too (Supabase only; a local database has no storage schema).
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    UPDATE storage.buckets
    SET allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf',
                                   'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
    WHERE id = 'member-documents';
  END IF;
END $$;
