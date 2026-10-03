# FIH Phone Skin & Charm Viewer

Visor de skins y colgantes de **Flipping is Hard**, basado en
[FIH-Phone-Skin-Texture-Viewer](https://github.com/d1ll3x3/FIH-Phone-Skin-Texture-Viewer).
Permite previsualizar el telefono y cargar charms convertidos desde un AssetBundle de Unity.

## Ejecutar en Windows

Instala Python 3.12 o posterior. Abre PowerShell en esta carpeta y ejecuta:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-viewer.ps1
```

El script crea un entorno `.venv`, instala `tools/requirements.txt` en el primer
inicio y abre el navegador. El servidor escucha solo en tu equipo, en
`http://127.0.0.1:8765/`; si el puerto esta ocupado, utiliza el siguiente libre.
Mantiene visible la URL elegida en la terminal. Detenlo con `Ctrl+C`.

Para elegir otro puerto o evitar que se abra otra ventana del navegador:

```powershell
.\start-viewer.ps1 -Port 9000 -NoBrowser
```

En el visor, selecciona **Charm** y carga tu bundle desde el mismo cuadro de
subida de las texturas, haciendo clic o arrastrando el archivo. El conversor procesa el
archivo localmente, con un limite de 64 MB, y elimina su copia temporal al terminar.
El charm de prueba se ofrece como JSON ya convertido, por lo que se puede abrir
sin instalar Unity ni modificar la instalacion del juego.
`assets/charms/hat.json` procede del `hatbundle` facilitado para las pruebas;
`assets/charms/hat.js` contiene el mismo charm para cargarlo como ejemplo estatico.
`assets/charms/hat-preset.json` conserva el preset MC2 facilitado por el usuario.
Se aplica por defecto a MeshCloth. Tambien puedes cargar otro preset JSON desde
el mismo cuadro, con **Charm** seleccionado, sin sustituir la malla actual.
En esa pestana, **Hide phone** oculta solo la malla del telefono para inspeccionar
el charm. El giro y las fisicas siguen activos. **Phone collisions** activa las
colisiones con el telefono; esta desactivado por defecto y es independiente de
su visibilidad. Estas opciones se mantienen al cambiar de charm o pestana,
hasta recargar la pagina.

## Convertir Un Bundle A JSON

Tambien puedes convertir desde la terminal:

```powershell
.\.venv\Scripts\python.exe tools\convert_charm.py "I:\SteamLibrary\steamapps\common\Flipping is Hard Demo\BepInEx\plugins\charmreplacer\hatbundle" "hat.charm.json"
```

El JSON contiene geometria, texturas y la jerarquia necesarias para mostrar el
charm. Cargalo con el mismo control del visor. Para inspeccionar la extraccion,
puedes pasar `--report "hat.report.json"` al conversor.

## GitHub Pages

El visor y los charms en JSON funcionan en un alojamiento estatico, incluido
GitHub Pages. Publica `index.html`, `scripts/`, `assets/` y `vendor/` del repositorio. Para
cargar otro charm en Pages, conviertelo antes con `tools/convert_charm.py` y
selecciona el JSON desde el visor.

La carga directa de un bundle de Unity requiere el servidor local de Python.
GitHub Pages sirve archivos estaticos y no ejecuta el conversor.

## Fisicas Y Compatibilidad

El navegador usa Three.js para la representacion y Cannon.js 0.6.2 para la
simulacion. El charm de prueba conserva su malla proxy de MagicaCloth: sus
particulas, puntos fijos y restricciones deforman la malla visible al mover el
telefono. Otros charms pueden usar sus huesos o un cuerpo colgante, segun los
datos disponibles. **No ejecuta MagicaCloth ni reproduce exactamente sus fisicas**:
MagicaCloth es un componente de Unity y sus scripts compilados no se ejecutan
en el visor web. La simulacion ofrece una previsualizacion; valida el resultado
final dentro del juego.

La extraccion conserva los datos disponibles del prefab, sus mallas y sus
texturas. Las configuraciones o componentes que no puedan representarse en
el navegador quedan indicados en los avisos del JSON. Los bundles que dependan
de recursos externos ausentes pueden necesitar una conversion adicional.

La gorra incluida conserva 60 puntos proxy, cuatro puntos fijos, 45 vertices
fijos de la malla visible y 165
restricciones de distancia y las profundidades/jerarquia del prebuild.
La seleccion fija de MC2 mantiene el enganche en su posicion y orientacion
locales respecto al telefono, sin endurecer las particulas moviles.
El preset externo MC2 aporta gravedad (10), damping (0), curvas de restauracion
y limite de angulo, compresion tether (0.1), rigidez de distancia/flexion,
atenuacion de restauracion (1), suavizado de inercia y limites de velocidad.
Las curvas Unity se evaluan con interpolacion Hermite; los angulos usan el rango
normalizado de 180 grados. Las fuerzas se adaptan a las ecuaciones de Cannon,
con una respuesta angular mas suave: restauracion al 8% y correccion del limite
al 10% de sus valores, sin aumentar la rigidez por la masa de las ramas.
El preset original no se modifica. No se anade viento ni muelles
para mantener una pose impuesta. El bloque Spring no se utiliza en MeshCloth.
Cuando el telefono esta quieto y la postura se ha asentado, el conjunto entra
en reposo para eliminar oscilacion numerica residual. Moverlo reactiva la fisica.
Tras medio segundo sin movimiento del telefono, se aplica una resistencia
pasiva a la velocidad para apagar el balanceo, sin atraer la malla a una pose.
Esa resistencia no se aplica mientras se mueve el telefono.

Esta adaptacion no reproduce los jobs, las iteraciones ni todas las restricciones
internas de MagicaCloth. La flexion triangular sigue usando una aproximacion
mediante distancias, y el visor no tiene animacion local ni viento.
Las colisiones opcionales usan un volumen rectangular del telefono y esferas
en las particulas moviles del charm. No son los colliders exactos de Unity ni
incluyen autocollisiones. Los puntos fijos no colisionan con su propio telefono.
El bundle por si solo no incluye los parametros de ejecucion del juego: el
preset es un archivo separado y puede corresponder a una configuracion diferente.

La posicion conserva los offsets X=-0.25 y Z=-0.15 respecto al enganche
superior derecho, en unidades de altura del telefono. La altura del enganche
queda fija al 2% respecto al borde superior, sin controles de posicion.
El charm conserva su escala nativa del bundle,
incluidas las escalas de sus nodos; no se normaliza para encajar en el telefono.
La gorra esta girada 180 grados respecto a la orientacion anterior.
El charm no colisiona con el telefono salvo que actives **Phone collisions**.

Arrastrar la vista gira fisicamente el telefono y sus anclajes; la fisica
responde a ese movimiento. Un dedo tambien gira el objeto. La rueda o el
gesto de pinza ajusta el zoom, y el boton derecho desplaza la vista.
Los botones de vista y la rotacion automatica tambien mueven el telefono.
La [documentacion de MagicaCloth2](https://magicasoft.jp/en/mc2_about/)
explica su dependencia de Unity y la limitacion de WebGL.

## Pruebas

Las pruebas de fisicas se ejecutan con Node.js, sin instalar paquetes:

```powershell
node tests/charm-physics.test.cjs
node tests/phone-controls.test.cjs
node tests/mc2-preset.test.cjs
node tests/charm-collisions.test.cjs
.\.venv\Scripts\python.exe -m unittest discover -s tools -p "test_*.py"
```

Para comprobar el renderizado y los controles en el navegador:

```powershell
npm install
npx playwright install chromium
npm run test:browser
```

La prueba abre el HTML directamente. Define `VIEWER_URL` para usar un servidor,
`CHARM_BUNDLE` para probar la carga directa de un bundle y `PLAYWRIGHT_CHANNEL`
como `msedge` para usar Edge instalado. Las capturas se guardan en `.test-output/`.
