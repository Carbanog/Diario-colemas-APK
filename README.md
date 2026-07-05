# Colmenar Zeta — versión Android (APK independiente)

Es una copia del mismo Colmenar Zeta, pero pensada para instalarse como una app normal
en un móvil Android, sin depender de tu NAS ni de internet (salvo para el clima).
Cada persona que la instale tendrá sus propios datos, guardados solo en su teléfono.

**Aviso honesto**: esta es la primera vez que montamos esta versión. A diferencia de la
de escritorio (que reaprovechaba un motor ya probado), aquí hay piezas nuevas que no he
podido probar en un móvil de verdad desde donde yo trabajo. Es muy posible que en la
primera prueba real aparezca algún fallo — tenlo en cuenta e instálalo primero tú, antes
de repartirlo a nadie.

---

## Qué vas a hacer, en resumen

1. Crear una cuenta gratuita en GitHub (si no la creaste ya para la versión de escritorio, sirve la misma).
2. Crear un repositorio **nuevo** (distinto al de escritorio) y subir esta carpeta.
3. Esperar unos minutos mientras un robot fabrica el `.apk`.
4. Descargarlo e instalarlo en un Android.

---

## Paso 1 y 2 — Cuenta y repositorio

Igual que hicimos con la versión de escritorio: **New** → nombre, por ejemplo
`colmenar-zeta-android` → **Create repository** → subes todos los archivos de esta
carpeta (incluida la carpeta `.github`, que es la que arranca la compilación — recuerda
que tu explorador de archivos puede ocultarla por empezar con un punto, usa "Add file →
Create new file" si hace falta, como ya hicimos la vez pasada).

**Importante**: sube también el archivo `debug.keystore` que viene en esta carpeta. Es
la "firma" que hace que puedas instalar versiones futuras encima de esta sin perder los
datos — si no lo subes, cada compilación tendría una firma distinta y las actualizaciones
fallarían.

## Paso 3 — Esperar la compilación

Pestaña **Actions** de tu repositorio. Esta vez tarda un poco más que la de escritorio
(unos 5-8 minutos), porque tiene que preparar herramientas de Android además de compilar.

## Paso 4 — Descargar el APK

Cuando el proceso se ponga verde, entra en él → abajo, en **"Artifacts"** →
`ColmenarZeta-Android` → descárgalo (viene comprimido, descomprímelo para sacar el
archivo `app-debug.apk`).

## Paso 5 — Instalarlo en el móvil

1. Pasa el archivo `app-debug.apk` al teléfono (por cable, Drive, WhatsApp a ti mismo, lo que te sea más cómodo).
2. Ábrelo desde el propio teléfono (por ejemplo, desde la app de Archivos).
3. Android avisará de **"instalar apps de origen desconocido"** — es normal, no viene de
   la Play Store. Actívalo solo para la app que estás usando para instalarlo (Android te
   lo pide en el momento), y confirma.
4. Se instala como cualquier app normal, con su icono en el cajón de aplicaciones.

## Repartirlo a otras personas

Una vez comprobado que te funciona a ti, les pasas el mismo `app-debug.apk` (WhatsApp,
lo que sea). Cada uno lo instala igual que tú, y cada uno tendrá su propio colmenar,
sin relación con el tuyo ni con el de nadie más.

---

## Cómo funciona por dentro (para que sepas qué esperar)

- **Sin conexión**: la app funciona sin internet. Solo pide conexión para dos cosas
  puntuales: el clima (pestaña Clima) y las tipografías bonitas del título (si no hay
  internet, se ve con una fuente normal del sistema, nada se rompe).
- **Fotos**: se guardan dentro de la propia base de datos de la app, no como archivos sueltos.
- **Copia de seguridad / Excel**: en vez de "descargar" como en un ordenador, se abre el
  menú de compartir de Android — puedes mandarlo por WhatsApp, guardarlo en Drive, etc.
- **Actualizaciones futuras**: si te doy cambios, repites el Paso 2 (subir archivos
  nuevos al mismo repositorio) y el Paso 4 (descargar el APK nuevo). Al instalarlo
  encima del anterior, los datos de cada persona se mantienen — gracias a la firma fija
  del Paso 2, Android lo trata como una actualización, no como una app distinta.

## Si algo falla en la primera prueba

Es razonablemente probable que algo no vaya a la primera (por ejemplo: que no arranque,
que se quede en blanco, que falle al guardar una foto). Si pasa, dime exactamente:
- en qué pantalla estabas
- qué hiciste justo antes
- si salió algún mensaje de error

y lo revisamos igual que hemos ido puliendo el resto de la app.
