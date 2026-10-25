# Proposed fields

Form boxes currently mapped with `{ ask: ... }` because the field registry has nothing for
them. Most-needed so far: `business.telefono` (7 procedures), `business.forma_giuridica` (5), `procuratore.*` (3),
`business.data_cessazione` (3). When a field is needed by two or more procedures, add it to `contract/extensions.json`,
run `npm run gen:fields`, and switch those mappings from `ask` to the new field.

| Proposed field | Meaning | Needed by |
|---|---|---|
| `business.forma_giuridica` | Legal form (ditta individuale, srl, snc…) | `scia-esercizio-vicinato`, `scia-acconciatore-estetista`, `cila-lavori-edilizi`, `subingresso-attivita-commerciale`, `cessazione-attivita-commerciale` |
| `business.telefono` | Business phone | `scia-esercizio-vicinato`, `scia-acconciatore-estetista`, `iscrizione-impresa-individuale-comunica`, `cila-lavori-edilizi`, `subingresso-attivita-commerciale`, `cessazione-attivita-commerciale`, `scia-prevenzione-incendi` |
| `business.sede_legale_stato`, `residenza.stato` | Country of registered office / residence | `scia-esercizio-vicinato`, `cila-lavori-edilizi` |
| `business.data_cessazione` | Closing date shared by SUAP, Registro Imprese, AdE and TARI | `tari-cessazione-non-domestica`, `chiusura-partita-iva-persona-fisica`, `cessazione-attivita-commerciale` |
| `procuratore.*` | Agent filing under a procura speciale (name, CF, birth, residence, PEC, phone, role) | `scia-esercizio-vicinato`, `scia-acconciatore-estetista`, `iscrizione-impresa-individuale-comunica` |
| `business.preposto_*`, `business.soci<N>_*` | Preposto and partners for Allegati A/B | `scia-esercizio-vicinato` |
| `business.requisito_professionale_*` | Food professional requirement (type, details, date) | `scia-esercizio-vicinato` |
| `locale.data_fine` | Date occupation of the premises ended | `tari-cessazione-non-domestica` |
| `locale.motivo_cessazione` | Why the premises were left | `tari-cessazione-non-domestica` |
| `locale.superficie_vendita_mq` (+ alimentare / non alimentare) | Selling area, not the whole surface | `scia-esercizio-vicinato` |
| `locale.posti_a_sedere_totali`, `locale.servizi_igienici` | Seats and toilets | `concessione-suolo-pubblico-dehors` |
| `locale.data_avvio_attivita` | Start of the activity (not of occupation) | `registrazione-attivita-alimentare` |
| `locale.numero_registrazione_asl`, `locale.linee_attivita_osa` | ASL registration number and activity lines | `registrazione-attivita-alimentare` |
| A second premises unit (`locale2.*` or `locale.immobile<N>_*`) | Businesses using more than one unit | `tari-*-non-domestica` |
| Previous holder / taker-over (`subentrante.*`, `precedente_*`) | Voltura and cessione d'azienda | `tari-variazione-non-domestica`, `tari-cessazione-non-domestica` |
| `tari_ditta.codice_contribuente`, `tari_ditta.superficie_dichiarata_mq` | The business's own TARI position (`tari.*` is the home's) | `tari-*-non-domestica` |
| `suap.id_pratica` | Practice code assigned by impresainungiorno | `scia-somministrazione-alimenti-bevande` |
| `responsabile_tecnico.*` | Technical manager: name, CF, role, qualification (title, issuer, date, act) | `scia-acconciatore-estetista` |
| `tecnico.*` | Qualified technician: name, CF, ordine/collegio, number, PEC | `cila-lavori-edilizi` |
| `locale.scala`, `locale.piano`, `locale.telefono`, `locale.superficie_totale_mq` | More premises details | `cila-lavori-edilizi`, `scia-acconciatore-estetista` |
| `locale.catasto_tipo`, `locale.catasto_sezione_censuaria` | Catasto fabbricati/terreni; census section | `cila-lavori-edilizi` |
| `locale.registrazione_*` | Registration of the lease/comodato for the premises (date, office, number, series) | `apertura-partita-iva-persona-fisica` |
| `business.sito_web`, `business.data_inizio_attivita`, `business.depositario_scritture_*`, `business.cciaa` | More business details | `apertura-partita-iva-persona-fisica`, `cila-lavori-edilizi` |
| `struttura.*` | Accommodation: name, type, stars, CIN, CUSR, rooms, beds, business form, GEIS code, police station | `imposta-di-soggiorno-gestori`, `avvio-bed-and-breakfast` |
| `riscossione.*` | Cartella instalment request: cartella numbers, amount, number and type of instalments | `rateizzazione-cartella` |
| `tari.avviso_protocollo`, `tari.avviso_data` | The TARI notice being contested | `tari-autotutela-avviso-non-domestica` |
| `pratica.codice_comunica`, `firma.luogo` | ComUnica practice code; place of signing | `iscrizione-impresa-individuale-comunica`, `rateizzazione-cartella` |
| `suap.titolo_protocollo`, `suap.titolo_data` | Protocol and date of the SCIA/permit that opened the business | `cessazione-attivita-commerciale`, `subingresso-attivita-commerciale` |
| `subingresso.*` | Takeover: seller, seller's title, reason, deed registration, start date | `subingresso-attivita-commerciale` |
| `prevenzione_incendi.*` | VVF practice number, Allegato I activities, category, first SCIA and last renewal dates | `scia-prevenzione-incendi` |
| `locazione_breve.*` | The flat let short-term: address, police station, name, CUSR, CIN | `comunicazione-locazione-breve` |
| `veicolo.targa`, `veicolo.tipo` | Vehicle on a traffic fine | `verbale-pagamento-ricorso` |
| `business.inail_codice_ditta`, `business.inail_pat`, `business.inail_codice_sede` | INAIL position codes for the F24 | `autoliquidazione` |
