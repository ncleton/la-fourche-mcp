# La Fourche MCP

Ce dépôt fournit un serveur MCP et une CLI partageant le même client métier pour le site La Fourche (https://lafourche.fr), via une session Camoufox persistante appartenant à l’utilisateur.

- Ne jamais demander, afficher, journaliser ou versionner mot de passe, code 2FA, CAPTCHA, cookie, jeton, adresse, commande ou paiement.
- Ne jamais contourner une authentification, une vérification anti-robot ou une protection du site. La connexion reste une action humaine dans Camoufox.
- Toute preuve produit est observée sur le site officiel La Fourche au moment de l’appel.
- Ne jamais inventer une route, un champ, un stock, un prix ou une réponse de secours. Échouer explicitement quand le contrat observé change.
- Toute mutation de panier utilise une fiche fraîche, prévisualise l’effet, exige une confirmation liée à l’état courant du panier, sérialise l’écriture et relit le panier réel.
- Aucun outil ne choisit de créneau, ne valide de commande et ne paie. Modes de réception du site : livraison à domicile et retrait en magasin ou en point de retrait (click and collect).
- Les profils Camoufox sont isolés par utilisateur et par compte. Aucun secret ou état de session ne doit se trouver dans Git ou dans les réponses MCP.
- Le contrat propre à l’enseigne vit dans `src/client/site.ts` ; le reste du code est commun à tous les MCP d’achat AgentVegan.
- Avant publication : `npm ci && npm run verify`, test avec le SDK MCP officiel, audit de confidentialité et installation depuis le paquet produit.
