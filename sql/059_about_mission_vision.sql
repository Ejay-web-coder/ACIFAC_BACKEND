-- The cooperative's mission and vision, as on the signs in the office, in
-- Filipino and English (one paragraph each). Filled in only while both are
-- still blank, so text the office already wrote in the app is kept.
UPDATE about_content
   SET mission = E'Naglilingkod nang may katapatan at disiplina.\n\nServing with Loyalty and Discipline.',
       vision = E'Kooperatibang matatag, maunlad at maaasahan.\n\nStrong Cooperative, Progressive and Reliable.',
       updated_at = NOW()
 WHERE id = 1 AND mission = '' AND vision = '';
