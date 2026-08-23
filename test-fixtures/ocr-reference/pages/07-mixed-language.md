---
id: 07
trait: mixed-language
language: de-en
difficulty: hard
writing: Normale Handschrift. Die englischen Begriffe genau so schreiben wie hier.
---

Notizen aus dem Gespräch

Der Cache wird beim Start einmal aufgebaut, danach nur noch invalidiert. Das Rendering läuft in
einem eigenen Worker, damit der main Thread frei bleibt.

Offen: ob wir das Retry auf Backend-Ebene machen oder im Client. Ein Timeout von 30 Sekunden ist
vermutlich zu kurz für große Dokumente.

Nächster Schritt: einen Prototyp bauen und die Latenz messen. Ohne Zahlen ist die Diskussion
sinnlos.
