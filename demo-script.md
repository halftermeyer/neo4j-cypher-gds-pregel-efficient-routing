# Script de démo — jumeau numérique réseau : routage sensible aux politiques avec Cypher, GDS et Pregel

Ce fichier sert à la fois de fil conducteur pour le présentateur et d'entrée pour la vidéo.
Le recorder ne lit que les blocs `scene` ; tout le reste est pour les humains. La narration est en français,
l'interface de l'application reste en anglais.

Fil rouge : une banque internationale compare des moteurs de graphes. On lui a dit que Neo4j ne sait pas faire de
K chemins sensibles aux politiques, ni de convergence BGP. Chaque onglet répond à une objection, en direct.

```scene-config
title: "Jumeau numérique réseau"
subtitle: "Routage sensible aux politiques avec Cypher, GDS et Pregel"
viewport: { width: 1920, height: 1080 }
pad_s: 1.0
voice: "Kore"
tts_model: "gemini-2.5-flash-preview-tts"
tts_style: "Parle en français, d'un ton posé et professionnel, comme un ingénieur qui présente une démonstration technique à une équipe réseau."
```

## Acte 1 — Le contexte et le point de départ

```scene
id: s00-story
actions:
  - goto: "/"
  - wait_for: "testid:problem"
shot: "testid:problem"
narration: >
  Une banque internationale compare des moteurs de graphes pour son jumeau numérique réseau.
  On lui a dit que Neo4j ne sait pas faire de chemins sensibles aux politiques, ni de convergence BGP.
  Chaque onglet répond à une objection, en direct, avec de vraies requêtes.
```

```scene
id: s01-ingest
actions:
  - click: "role:button=ingest"
  - wait_any:
      targets: ["text:Project the base GDS graph"]
      timeout_ms: 90000
  - wait_ms: 2500
shot: "testid:db-stats"
narrate: at_start
narration: >
  On part d'une base vide. L'ingestion est déclenchée depuis l'application, avec des générateurs déterministes.
  Quatre cent soixante-deux équipements, leurs interfaces d'entrée et de sortie, des listes de contrôle d'accès,
  et un réseau BGP vérifié à la main.
```

## Acte 2 — Objection 1 : le modèle d'ACL

```scene
id: s02-acl-model
actions:
  - click: "role:tab=ACL model"
  - wait_for: "testid:problem"
shot: "testid:problem"
narration: >
  Première objection : un graphe ne connaît que la topologie, il ignore les règles des pare-feu.
  Ici, chaque interface est coupée en un nœud d'entrée et un nœud de sortie.
  Traverser un équipement, c'est être filtré deux fois. Première règle qui correspond gagne, sinon refus implicite.
```

```scene
id: s03-acl-eval
actions:
  - click: "role:button=Evaluate the flow"
  - wait_any:
      targets: ["text:Every hop permits", "text:hop(s) deny"]
      timeout_ms: 60000
shot: "text:Physical shortest path"
narration: >
  Un flux web du campus vers un centre de données. Pour chaque saut, la ligne de l'ACL qui décide est affichée,
  dans les deux modèles de stockage : les listes sur l'interface, et les entrées d'ACL sous forme de nœuds.
```

```scene
id: s04-acl-deny
actions:
  - select: { target: "css:select.sel", value: "1" }
  - click: "role:button=Evaluate the flow"
  - wait_for: "text:hop(s) deny"
shot: "text:Physical shortest path"
narration: >
  Même chemin, mais en SSH. Une règle explicite refuse le flux à la porte du centre de données :
  le chemin physiquement le plus court n'est pas utilisable. Les deux modèles décident à l'identique.
```

```scene
id: s05-acl-equiv
actions:
  - click: "role:button=Compare both models"
  - wait_any:
      targets: ["text:identical blocked-interface sets"]
      timeout_ms: 90000
shot: "text:Equivalence check: both models"
narration: >
  La preuve d'équivalence : cent flux, les deux modèles, les mêmes interfaces bloquées à chaque fois.
  Et les temps médians sont mesurés en direct, sur cette instance.
```

## Acte 3 — Objection 2 : les K chemins sous contrainte de politique

```scene
id: s06-kpaths-problem
actions:
  - click: "role:tab=K permitted paths"
  - wait_for: "testid:problem"
shot: "testid:problem"
narration: >
  Deuxième objection : les K plus courts chemins sont les plus courts physiquement, et les filtrer après coup ne laisse rien.
  Le piège est réel. La solution : évaluer les ACL avant Yen, avec Cypher, puis filtrer une projection partagée.
```

```scene
id: s07-trap
actions:
  - click: "role:button=Plant deny"
  - wait_for: "text:denied at:"
  - click: "role:button=Run both approaches"
  - wait_any:
      targets: ["text:permitted paths returned"]
      timeout_ms: 60000
shot: "text:Post-filter: Yen top-3"
narration: >
  On pose une règle de refus sur chacun des trois meilleurs chemins. À gauche, filtrer après Yen : zéro chemin.
  À droite, ACL d'abord, puis Yen : trois chemins autorisés. Une seule requête, un seul modèle.
```

```scene
id: s08-failures
actions:
  - click: "role:button=Run flows on different ports"
  - wait_for: "text:best cost"
  - click: "role:button=Fail a transit device"
  - wait_for: "text:the model was not modified"
shot: "text:3 · Same model, different flows"
narration: >
  Même modèle, autres ports : autres réponses, sans rien reconstruire.
  Et une panne d'équipement ou de lien est exclue au moment du filtre, sans modifier le graphe.
```

```scene
id: s09-bench-perflow
actions:
  - click: "role:button=Run on"
  - fast_begin: true
  - wait_any:
      targets: ["text:identical results"]
      timeout_ms: 180000
  - fast_end: true
shot: "text:Benchmark · per-flow latency"
narration: >
  Les performances sont mesurées, pas annoncées. Cent flux dans une base isolée,
  avec la taille de l'instance : la projection de base plus le filtre, contre une projection par requête.
  Les résultats sont identiques, et la médiane tient en quelques dizaines de millisecondes.
```

## Acte 4 — Objection 3 : élaguer dans Cypher

```scene
id: s10-prune
before:
  - dismiss: "role:button=Remove every planted ACE"
actions:
  - click: "role:tab=Pruning in Cypher"
  - wait_for: "testid:problem"
  - click: "role:button=Run QPP and Yen"
  - wait_for: "text:same costs as Yen"
shot: "text:Result: budget"
narration: >
  Troisième objection : Cypher énumère tous les chemins puis filtre. Avec un budget de coût, ce n'est plus vrai.
  Les motifs de chemins quantifiés et allReduce mettent le budget dans l'expansion elle-même.
  Les chemins trouvés ont les mêmes coûts que ceux de Yen.
```

```scene
id: s11-prune-plan
actions:
  - click: "role:button=EXPLAIN"
  - wait_for: "text:Execution plan: the budget is inside the expansion"
shot: "text:Execution plan: the budget is inside the expansion"
narration: >
  Le plan d'exécution le prouve : l'allReduce est inliné dans l'opérateur d'expansion.
  L'élagage se fait pendant que les chemins grandissent, pas après.
```

```scene
id: s11b-prune-equiv
actions:
  - click: "role:button=Compare on 100 seeded flows"
  - fast_begin: true
  - wait_any:
      targets: ["text:identical to Yen"]
      timeout_ms: 240000
  - fast_end: true
shot: "text:Equivalence check: QPP = Yen"
narration: >
  Cent flux comparés à Yen : mêmes coûts à chaque fois, sans délai dépassé.
  Notre recommandation : Yen pour les K plus courts, la forme Cypher quand un budget est connu.
```

## Acte 5 — Objection 4 : fraîcheur et passage à l'échelle

```scene
id: s12-fresh-acl
actions:
  - click: "role:tab=Freshness"
  - wait_for: "testid:problem"
  - click: "role:button=Deny tcp/7005"
  - wait_for: "text:best path after"
shot: "text:A · Change an ACL"
narration: >
  Quatrième objection : un moteur en mémoire travaille sur un instantané périmé.
  Un changement d'ACL est visible dès la requête suivante, parce que les ACL sont lues dans la base pour chaque flux.
  Le chemin change, la projection de base n'a pas bougé.
```

```scene
id: s13-fresh-topo
before:
  - dismiss: "role:button=Undo"
actions:
  - click: "role:button=Add a direct link"
  - wait_for: "text:stale"
  - click: "role:button=Refresh the base projection"
  - wait_for: "text:refresh took"
shot: "text:B · Change the topology"
narration: >
  Un changement de topologie est différent, et on le montre honnêtement.
  La projection par requête voit le nouveau lien tout de suite. La projection de base est périmée jusqu'à son rafraîchissement,
  un coût ponctuel, mesuré ici.
```

```scene
id: s14-fresh-scale
before:
  - dismiss: "role:button=Remove the link"
actions:
  - click: "role:button=Run: as generated"
  - fast_begin: true
  - wait_any:
      targets: ["text:301,"]
      timeout_ms: 600000
  - fast_end: true
shot: "text:Benchmark · ACL density"
narration: >
  Et le passage à l'échelle. On ajoute des entrées d'ACL qui ne correspondent jamais, jusqu'à plus de trois cent mille :
  le pire cas. Les résultats restent identiques à chaque niveau, et la latence est mesurée en direct.
```

## Acte 6 — VRF

```scene
id: s15-vrf
actions:
  - click: "role:tab=VRF"
  - wait_for: "testid:problem"
  - click: "role:button=1 · Assign VRFs"
  - click: "role:button=2 · Run the flows"
  - wait_for: "text:as expected"
shot: "text:Run it"
narration: >
  Cinquième objection : un réseau multi-locataire a besoin de tables de routage séparées.
  Un VRF est un filtre de plus, par flux. Les interfaces d'un autre VRF sont retirées du graphe filtré
  avec celles que les ACL refusent. Rien n'est dupliqué, rien n'est reconstruit.
```

## Acte 7 — BGP

```scene
id: s16-bgp-problem
before:
  - dismiss: "role:button=Remove VRFs"
actions:
  - click: "role:tab=BGP"
  - wait_for: "testid:problem"
  - click: "role:button=Load the hand-checked network"
  - wait_for: "text:7 routers"
shot: "testid:problem"
narration: >
  Dernière objection, la plus sérieuse : Neo4j ne ferait pas de convergence BGP.
  BGP n'est pas une recherche de chemins. Un routeur n'annonce que sa meilleure route,
  et le réseau se stabilise sur un point fixe. Voici un petit réseau, vérifié à la main.
```

```scene
id: s17-bgp-enum
actions:
  - click: "role:button=Run both on this network"
  - wait_for: "text:wrong with path enumeration"
  - click: "role:button=Run on 20 random networks"
  - wait_any:
      targets: ["text:exact with path enumeration"]
      timeout_ms: 180000
shot: "text:A · Path enumeration"
narration: >
  Le raccourci par énumération de chemins, avec des accumulateurs par chemin, compte des routes
  que les routeurs intermédiaires n'annoncent jamais. Résultat : des meilleures routes fausses,
  sur le réseau vérifié à la main comme sur vingt réseaux aléatoires.
```

```scene
id: s18-bgp-converge
actions:
  - click: "role:button=Cypher loop (server side)"
  - wait_for: "text:changes/round"
  - click: "role:button=GDS Pregel"
  - wait_for: "text:identical routing tables"
shot: "text:B · Converge it twice"
narration: >
  Les mêmes règles, convergées deux fois : par une boucle Cypher côté serveur, une transaction par tour,
  et par une procédure Pregel de GDS. Les deux tables de routage sont identiques, et conformes au tableau établi à la main.
```

```scene
id: s18b-bgp-equiv
actions:
  - click: "role:button=Equivalence check on 20 random networks"
  - fast_begin: true
  - wait_any:
      targets: ["text:oscillating, flagged by both"]
      timeout_ms: 240000
  - fast_end: true
shot: "text:Equivalence check on 20 random networks"
narration: >
  Vingt réseaux aléatoires : la boucle Cypher et Pregel égalent la référence à chaque fois,
  et les réseaux qui oscillent sont signalés par les deux moteurs, au lieu de renvoyer une réponse inventée.
```

```scene
id: s19-bgp-anim
actions:
  - click: "role:button=Compute supersteps with Pregel and play"
  - wait_for: "text:routers changed"
  - wait_ms: 4000
shot: "text:C · Watch it converge"
narration: >
  Chaque image est une vraie exécution de Pregel, avec un nombre d'itérations croissant.
  En ambre, les routeurs dont la table change à ce tour : on voit la convergence se propager, jusqu'au point fixe.
```

```scene
id: s20-bgp-whatif
actions:
  - click: "role:button=Apply, recompute, diff"
  - wait_for: "text:routing-table entries changed"
shot: "text:D · What-if"
narration: >
  Et un what-if : on change une politique, on recalcule, et on obtient le différentiel des tables de routage,
  vérifié contre la référence.
```

```scene
id: s21-bgp-osc
before:
  - dismiss: "role:button=Revert"
actions:
  - click: "role:button=Find an oscillating one"
  - wait_for: "text:oscillating network, seed"
  - click: "role:button=GDS Pregel"
  - wait_for: "text:Oscillation: no fixed point"
shot: "text:Oscillation: no fixed point"
narration: >
  Quand la politique est contradictoire, il n'y a pas de point fixe. Le moteur s'arrête au plafond d'itérations
  et le signale, plutôt que de renvoyer un résultat arbitraire.
```

## Acte 8 — Les chiffres et la transparence

```scene
id: s22-bench-bgp
actions:
  - click: "role:tab=Benchmark"
  - wait_for: "text:isolated database"
  - click: "role:button=Run on growing networks"
  - fast_begin: true
  - wait_any:
      targets: ['css:td:text-is("large")']
      timeout_ms: 600000
  - fast_end: true
shot: "text:Benchmark · Cypher fixed-point loop vs GDS Pregel"
narration: >
  Cypher contre Pregel, sur des réseaux de taille croissante, dans une base isolée.
  Les trois résultats sont identiques, et Pregel est de un à deux ordres de grandeur plus rapide.
  Les chiffres sont mesurés à l'instant, sur cette machine.
```

```scene
id: s23-audit
actions:
  - click: "role:button=Cypher ("
  - wait_ms: 2500
shot: "css:.audit-drawer"
narration: >
  Tout est auditable. Chaque requête exécutée est dans le tiroir Cypher, avec ses paramètres et son temps.
  Rien n'est préenregistré : ce que vous avez vu, vous pouvez le rejouer.
```

```scene
id: s24-end
before:
  - dismiss: "role:button=Cypher ("
actions:
  - click: "role:tab=Setup"
  - wait_for: "testid:db-stats"
shot: "testid:db-stats"
narration: >
  En résumé : des politiques évaluées avant l'algorithme, des K chemins sous contrainte,
  l'élagage dans Cypher, et BGP comme un point fixe, avec Cypher et Pregel. Le tout se réinitialise et se rejoue.
```
