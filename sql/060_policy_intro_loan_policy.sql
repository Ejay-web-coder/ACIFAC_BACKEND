-- Policies can have an introduction shown above the numbered rules (the loan
-- policy opens with its own vision and mission). The printed loan policy for
-- the ALERT-ARBOs program is added once, last in the list, unless a policy
-- with that title is already there. Additive only.
ALTER TABLE policies ADD COLUMN IF NOT EXISTS intro TEXT NOT NULL DEFAULT '';

INSERT INTO policies (title, intro, items, sort_order)
SELECT 'Polisiya sa Pagpapautang (ALERT-ARBOs)',
       $intro$Vision: Isang kooperatibang may maayos na pananalapi, may mga responsableng kasapi, at nakatutugon sa mga pangangailangang pang agrikultura kabilang na ang puhunang pansakahan.

Mission: Makahiram sa bangko ng puhunan upang ipahiram naman sa mga kasapi na may mababang interes upang matugunan ang pangangailangang pinansyal pang agrikultura, at makapagbayad sa takdang panahon.$intro$,
       $items$[
    "Ang maaring humiram sa loan program na ito ay mga Agrarian Reform Beneficiaries na lehitimong kasapi lamang ng ACIFAC.",
    "Hanggang dalawang ektarya lamang ang papayagan na mahiram ng kasapi sa unang taon ng operasyon (dalawang cropping).",
    "Kailangang mag-accomplish ng Loan Availment Form ang mga hihiram na kasapi.",
    "Ang halagang hihiramin ay para lamang sa panggastos sa sakahan. Magkakaroon ng pagbisita sa mga bukid upang masigurong gagamitin sa pinaglaanan ang perang hiniram.",
    "Magpapataw ng limang porsyento (5%) kada anim na buwan.",
    "Ang pagbabayad ay hanggang limang buwan lamang at magpapataw ng kaukulang multa na isandaang piso (Php100.00) kada araw pagkalipas ng limang araw na palugit.",
    "Bibigyan ng palugit (grace period) na limang araw mula sa takdang araw ng pagbabayad.",
    "Kailangang dumaan sa Loan Orientation ang mga nagnanais humiram at dadaan sa Credit and Collection Committee ang proseso ng paghiram. Kapag inirekomenda na ng CCC ang nanghihiram, ang Board of Directors pa din ang mag-aapruba. Bago ang pagrelease ng pera, kailangan munang dumaan sa PBD Lawyering Orientation ang manghihiram.",
    "Ang pag-aapply, pagre-release at pagbabayad ng loan ay sa opisina lamang isasagawa.\nMula ika-9:00 ng umaga hanggang ika-3:00 ng hapon.",
    "Ibabawas na sa loan proceeds ang savings na nagkakahalaga ng limandaang piso (Php500.00) kung ang halagang hiniram ay limampung libong piso (Php50,000.00) pababa at isanlibong piso (Php1,000.00) kung ang hiniram ay limampu't isang libo (Php51,000.00) pataas.",
    "Ibabawas din ang dalawang porsyento (2%) para sa Capital Build Up mula sa kabuuang Loan.",
    "Obligadong mag-avail ng life insurance na nasa ilalim ng PCIC ang manghihiram at may halaga itong limampung piso (Php50.00).",
    "Maaring ang bahagi ng hinihiram ay ibayad na kaagad sa serbisyong makinarya na ibabawas sa loan proceeds."
  ]$items$::jsonb,
       (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM policies)
WHERE NOT EXISTS (SELECT 1 FROM policies WHERE title = 'Polisiya sa Pagpapautang (ALERT-ARBOs)');
