# Proposed fields

Form boxes currently mapped with `{ ask: ... }` because the field registry has nothing for
them. When a field is needed by two or more procedures, add it to `contract/extensions.json`,
run `npm run gen:fields`, and switch those mappings from `ask` to the new field.

| Proposed field | Meaning | Needed by |
|---|---|---|
| `business.forma_giuridica` | Legal form (ditta individuale, srl, snc…) | `scia-esercizio-vicinato` |
| `business.telefono` | Business phone | `scia-esercizio-vicinato` |
| `business.sede_legale_stato`, `residenza.stato` | Country of registered office / residence | `scia-esercizio-vicinato` |
| `business.data_cessazione` | Date the partita IVA was closed | `tari-cessazione-non-domestica` |
| `procuratore.*` | Agent filing under a procura speciale (name, CF, birth, residence, PEC, phone, role) | `scia-esercizio-vicinato` |
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
