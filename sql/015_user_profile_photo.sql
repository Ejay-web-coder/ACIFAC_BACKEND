-- Profile picture of a login account (admin or member), uploaded by the account
-- owner, stored privately and served only to them. Members' official 2x2
-- registration photo stays separately on members.profile_photo.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS profile_photo TEXT;
