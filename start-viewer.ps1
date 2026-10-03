param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8765,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot
$venvPython = Join-Path $repoRoot '.venv\Scripts\python.exe'
$requirementsPath = Join-Path $repoRoot 'tools\requirements.txt'
$requirementsStamp = Join-Path $repoRoot '.venv\fih-requirements.sha256'

if (-not (Test-Path -LiteralPath $venvPython)) {
    $pythonCommand = $null
    $pythonArguments = @()
    if (Get-Command py -ErrorAction SilentlyContinue) {
        & py -3.12 -c 'import sys; assert sys.version_info >= (3, 12)' 2>$null
        if ($LASTEXITCODE -eq 0) {
            $pythonCommand = 'py'
            $pythonArguments = @('-3.12')
        }
    }
    if (-not $pythonCommand) {
        foreach ($candidate in @('python3.12', 'python', 'python3')) {
            if (Get-Command $candidate -ErrorAction SilentlyContinue) {
                & $candidate -c 'import sys; assert sys.version_info >= (3, 12)' 2>$null
                if ($LASTEXITCODE -eq 0) {
                    $pythonCommand = $candidate
                    break
                }
            }
        }
    }
    if (-not $pythonCommand) {
        throw 'Instala Python 3.12 o posterior y vuelve a ejecutar este script.'
    }
    Write-Host 'Creando entorno Python local...'
    & $pythonCommand @pythonArguments -m venv (Join-Path $repoRoot '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear el entorno Python.' }
}

$requirementsHash = (Get-FileHash -LiteralPath $requirementsPath -Algorithm SHA256).Hash
$installedHash = if (Test-Path -LiteralPath $requirementsStamp) {
    (Get-Content -LiteralPath $requirementsStamp -Raw).Trim()
} else { '' }
if ($requirementsHash -ne $installedHash) {
    Write-Host 'Instalando dependencias del conversor...'
    & $venvPython -m pip install -r $requirementsPath
    if ($LASTEXITCODE -ne 0) { throw 'No se pudieron instalar las dependencias.' }
    Set-Content -LiteralPath $requirementsStamp -Value $requirementsHash -Encoding ascii
}

$serverArguments = @((Join-Path $repoRoot 'tools\serve.py'), '--port', $Port)
if (-not $NoBrowser) { $serverArguments += '--open' }
& $venvPython @serverArguments
if ($LASTEXITCODE -ne 0) { throw 'El servidor local termino con un error.' }
