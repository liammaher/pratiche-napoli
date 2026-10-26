# Proposed fields

Form boxes currently mapped with `{ ask: ... }` because the field registry has nothing for
them. Most-needed so far: the previous holder or taker-over (4 procedures, but see below: it
stays an `ask`), then several needed by two. When a field is needed by two or more procedures,
add it to `contract/extensions.json`, run `npm run gen:fields`, and switch those mappings from `ask` to the new field.

Vault schema 13 added the fields below, and the procedures now use them:

| Field | Used by |
|---|---|
| `locale.telefono` | `scia-esercizio-vicinato`, `scia-acconciatore-estetista`, `subingresso-attivita-commerciale`, `cessazione-attivita-commerciale`, `scia-prevenzione-incendi` (both forms), `registrazione-attivita-alimentare` |
| `residenza.stato`, `business.sede_legale_stato` | the same first four, and `cila-lavori-edilizi` (residenza). Only for an address abroad: empty means Italia, and the rows' notes say to write it |
| `business.tari_codice_contribuente`; `locale.tari_data_dichiarazione`, `tari_protocollo`, `tari_superficie_tassata_mq`, `tari_categoria` | the business's own TARI position (`tari.*` is the home's): `records` of `tari-iscrizione-non-domestica`, `tari-variazione-non-domestica` and `tari-autotutela-avviso-non-domestica`; the variazione's "superficie dichiarata in precedenza" |

A second premises needed no new field: the vault keeps it as `locale2.*`, a numbered copy of
`locale` with the same fields and rules, and procedures may now name numbered copies of any
category the registry doesn't mark `one_only` (famiglia and ruolo are). The second unit's rows of
the TARI Mod. 5, 6 and 8 read `locale2.*`.

Vault schema 11 added the business fields below, and the procedures now use them:

| Field | Used by |
|---|---|
| `business.forma_giuridica` | `scia-esercizio-vicinato`, `scia-acconciatore-estetista`, `subingresso-attivita-commerciale`, `cessazione-attivita-commerciale` |
| `business.telefono` | the same four, `cila-lavori-edilizi`, `scia-prevenzione-incendi` (both forms), `iscrizione-impresa-individuale-comunica` (before the titolare's phone) |
| `business.cciaa` | `cila-lavori-edilizi`; the SCIA scheda anagrafica's "C.C.I.A.A. di ... prov.", before the REA sigla |
| `business.data_cessazione` | `chiusura-partita-iva-persona-fisica`, `tari-cessazione-non-domestica` (motivo a), `cessazione-attivita-commerciale` |
| `business.sito_web` | `apertura-partita-iva-persona-fisica` (commercio elettronico and Quadro I), `subingresso-attivita-commerciale` |
| `business.inail_codice_ditta`, `inail_pat`, `inail_codice_sede` | `autoliquidazione` (`records`, from the certificato di assicurazione) |

`business.data_inizio_attivita`, `data_costituzione`, `capitale_sociale`, `inps_matricola`, `ccnl`,
`pec_data_scadenza`, `durc_data_scadenza`, `albo.*`, `cassa.*` and `firma_digitale.*` are in the
registry too; no form box needs them yet. The phone of the premises ("Telefono (attività)") is
not the business's: since schema 13 it is `locale.telefono`.

Vault schema 12 added `procura.ente`, `oggetto`, `data_conferimento` and `data_scadenza`: a
procura or delega a person gave the vault's principal, so a procedure can read it only from that
person (`party`, or `*:` in a `repeat` row), never as the owner's or the dichiarante's; in a
business vault, only from a `cliente`, which the validator enforces. No
procedure uses it yet, because every procura here goes the other way: the titolare gives one to
the procuratore or the tecnico (the SCIA and CILA quadri, the ComUnica procura), and the
deleghe on the Agenzia delle Entrate, ADER and VVF forms are given by the dichiarante on the form
itself. No form asks for the ente, oggetto or dates of a procura someone gave; the only such date
is when the dichiarante signs the ADER delega (`rateizzazione-cartella`), still an `ask`.

People other than the business are no longer proposed as fields: in a business vault they are
people with a `ruolo`, and procedures pick them with `party` and `repeat: { ruolo }` (see
CONTRIBUTING). The procuratore (`scia-esercizio-vicinato`, `scia-acconciatore-estetista`,
`subingresso-attivita-commerciale`, `cessazione-attivita-commerciale`, and the ComUnica procura),
the preposto and the other soci (Allegati B and A) and the responsabili tecnici (Allegati B and
C of `scia-acconciatore-estetista`) are mapped that way. Still `ask`: whether a procura is used
at all, the procuratore's "in qualità di", the date of a preposto's nomina (`ruolo.data_inizio`
is when the relationship began, often the hiring), and each person's professional requirement.
The acconciatore Allegato B and estetista Allegato C both list every responsabile tecnico, since
`ruolo` doesn't say which trade: the filler keeps each person on the right one.

| Proposed field | Meaning | Needed by |
|---|---|---|
| `business.requisito_professionale_*` | Food professional requirement (type, details, date) | `scia-esercizio-vicinato`, `subingresso-attivita-commerciale` |
| `locale.data_fine` | Date occupation of the premises ended | `tari-cessazione-non-domestica` |
| `famiglia.dimora` (si/no) | The person lives in the home at least 60 days a year, though not in the stato di famiglia: TARI counts them (Regolamento TARI art. 14, c. 1). Until then, the Mod. 1's coabitanti are an `ask` | `tari-iscrizione-uso-abitativo` |
| `locale.motivo_cessazione` | Why the premises were left | `tari-cessazione-non-domestica` |
| `locale.superficie_vendita_mq` (+ alimentare / non alimentare) | Selling area, not the whole surface | `scia-esercizio-vicinato` |
| `locale.posti_a_sedere_totali`, `locale.servizi_igienici` | Seats and toilets | `concessione-suolo-pubblico-dehors` |
| `locale.data_avvio_attivita` | Start of the activity (not of occupation) | `registrazione-attivita-alimentare` |
| `locale.numero_registrazione_asl`, `locale.linee_attivita_osa` | ASL registration number and activity lines | `registrazione-attivita-alimentare` |
| Previous holder / taker-over (`subentrante.*`, `precedente_*`) | Voltura and cessione d'azienda: the other side of one deal, not a person the business keeps, so not a `ruolo`; it stays an `ask` (CONTRIBUTING), since a vault field would keep a third party's data with no ruolo or retention period | `tari-variazione-non-domestica`, `tari-cessazione-non-domestica`, `subingresso-attivita-commerciale`, `registrazione-attivita-alimentare` |
| `suap.id_pratica` | Practice code assigned by impresainungiorno | `scia-somministrazione-alimenti-bevande` |
| `tecnico.*` | Qualified technician: name, CF, ordine/collegio, number, PEC. The vault has `albo.*` for a person; the CILA leaves these boxes to the tecnico, so no mapping yet | `cila-lavori-edilizi` |
| `locale.scala`, `locale.piano`, `locale.superficie_totale_mq` | More premises details | `cila-lavori-edilizi`, `scia-acconciatore-estetista` |
| `locale.catasto_tipo`, `locale.catasto_sezione_censuaria` | Catasto fabbricati/terreni; census section | `cila-lavori-edilizi` |
| `locale.registrazione_*` | Registration of the lease/comodato for the premises (date, office, number, series) | `apertura-partita-iva-persona-fisica` |
| `business.depositario_scritture_*` | Who keeps the accounting records, and where | `apertura-partita-iva-persona-fisica` |
| `struttura.*` | Accommodation: name, type, stars, CIN, CUSR, rooms, beds, business form, GEIS code, police station | `imposta-di-soggiorno-gestori`, `avvio-bed-and-breakfast` |
| `riscossione.*` | Cartella instalment request: cartella numbers, amount, number and type of instalments | `rateizzazione-cartella` |
| `tari.avviso_protocollo`, `tari.avviso_data` | The TARI notice being contested | `tari-autotutela-avviso-non-domestica` |
| `pratica.codice_comunica`, `firma.luogo` | ComUnica practice code; place of signing | `iscrizione-impresa-individuale-comunica`, `rateizzazione-cartella` |
| `suap.titolo_protocollo`, `suap.titolo_data` | Protocol and date of the SCIA/permit that opened the business | `cessazione-attivita-commerciale`, `subingresso-attivita-commerciale` |
| `subingresso.*` | Takeover: seller, seller's title, reason, deed registration, start date | `subingresso-attivita-commerciale` |
| `prevenzione_incendi.*` | VVF practice number, Allegato I activities, category, first SCIA and last renewal dates | `scia-prevenzione-incendi` |
| `locazione_breve.*` | The flat let short-term: address, police station, name, CUSR, CIN | `comunicazione-locazione-breve` |
| `veicolo.targa`, `veicolo.tipo` | Vehicle on a traffic fine | `verbale-pagamento-ricorso` |
