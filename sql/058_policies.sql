-- The About page's Policy tab: the cooperative's policies as text (a title and
-- numbered rules), written and changed by the office in the app and read by
-- everyone signed in. items is a JSON array of strings, one per numbered rule;
-- a rule may have more than one line (for example the member and non-member
-- shares). The three printed policies are filled in once, when the table is
-- still empty. Additive only.
CREATE TABLE IF NOT EXISTS policies (
  id SERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL CHECK (btrim(title) <> ''),
  items JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(items) = 'array'),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_policies_order ON policies(sort_order, id);

INSERT INTO policies (title, items, sort_order)
SELECT seed.title, seed.items::jsonb, seed.sort_order
FROM (VALUES
  ('Membership Policy', '[
    "Nakapag PMES",
    "Magbayad ng membership fee na 300.00 pesos.",
    "Age limit 18-65 years old",
    "Dadaan sa screening",
    "Magbayad ng initial paid-up capital na 1,000.00 pesos.",
    "Dadalo sa regular monthly meeting, General Assembly, Special Assembly.",
    "On time sa pagdalo sa mga pagpupulong",
    "Magbayad ng 250 every meeting para sa share capital subscription at 50 pesos para sa savings.",
    "Ang hindi pagdalo ng pagpupulong ng walang valid reason ay may penalty na 250.",
    "3 consecutive absent, ipapatawag ng pamunuan.",
    "Kung maglilipat ng pagiging kasapi, may 500 pesos transfer fee.",
    "Kung gustong magresign, resignation letter is a must.",
    "Ang member na nagresign ay hindi pupwedeng bumalik bilang kasapi ng kooperatiba.",
    "Tatangkilik sa anumang serbisyo ng kooperatiba.",
    "Aatend sa anumang mga trainings na inilaan para sa kooperatiba.",
    "Sumunod sa mga batas at alintuntunin na ipinatutupad ng kooperatiba."
  ]', 1),
  ('Board Meeting Policy', '[
    "Ang Board meeting ay dapat hindi bababa sa 4 na oras.",
    "On time",
    "At least dalawang policy ang magawa.",
    "Buwanang pagpupulong dapat maisagawa",
    "500 honorarium kada monthly meeting",
    "Kapag hindi umatend ng meeting w/o valid reason may multa 500.00.",
    "Paggawa ng Development Plan.",
    "Iulat sa general assembly ng lahat ng nagawa ng kooperatiba.",
    "Bumubo ng plano sa pagunlad ng kooperatiba.",
    "Suriin ang taunang plano at badyet at paaprubahan sa general assembly.",
    "Suriin, subaybayan ang mga plano ng kooperatiba kung ang mga program nito ay epektibo.",
    "3 consecutive absent sa meeting, subject for Board termination."
  ]', 2),
  ('Polisiya para sa Combined Harvester', '[
    "Magpa schedule sa manager 1-week bago araw ng harvest.",
    "Full tank ang fuel w/ 60L na reserved.",
    "700 ang allowance sa pagkain, 1000 kung mag overtime.",
    "21 per bag ang bayad sa labor ng mga tao nito.",
    "Hunos sa panahon ng tag-araw:\nMember: 100/9 with 5 commission\nNon-member: 100/10",
    "Hunos sa panahon ng tag-ulan:\nMember: may areahan - 4/5\nNon-member: 5/5",
    "Linisin ang makina pagkatapos ng operasyon.",
    "Araw-araw i-check ang lower part ng harvester bago ilusong sa susunod na operasyon, kung madumi linisin muna.",
    "Bayad sa pagbilad ng hunos 30 per bag.",
    "Igarahe ang makinarya sa garahe kung walang operasyon.",
    "Isauli sa manager ang susi.",
    "Hindi pwedeng iwanan ang makinarya kung saan-saan.",
    "Kung aabutin ng gabi ang operasyon, dapat na may bantay sa makinarya.",
    "Members Priority.",
    "5 pesos ang per kaban sa nagcanvas."
  ]', 3)
) AS seed(title, items, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM policies);
