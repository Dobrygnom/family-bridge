param(
    [string]$ArchiveRoot = "C:\Users\Dmitrii Zotov\Documents\New project\psychologist-memory",
    [string]$SourceThreadId = "6a68ce87-e968-83eb-a4af-7624e3963da8"
)

$ErrorActionPreference = 'Stop'
$transcriptPath = Join-Path $ArchiveRoot 'transcript.jsonl'
$memoryRoot = Join-Path $ArchiveRoot 'memory'
$summariesRoot = Join-Path $memoryRoot 'topic-summaries'
New-Item -ItemType Directory -Force -Path $summariesRoot | Out-Null

$messages = [System.Collections.Generic.List[object]]::new()
Get-Content -LiteralPath $transcriptPath -Encoding UTF8 | ForEach-Object {
    if (-not [string]::IsNullOrWhiteSpace($_)) { $messages.Add(($_ | ConvertFrom-Json)) }
}

$topics = [ordered]@{
    'relationships' = @{ title='Отношения и близость'; pattern='отнош|жен|муж|девуш|люб|свидан|роман|измен|развод|катя|ал[её]на|полин' }
    'emotions' = @{ title='Эмоции и саморегуляция'; pattern='чувств|эмоц|страх|тревог|боль|груст|счаст|злост|одиноч|пережив' }
    'identity' = @{ title='Самооценка и личная идентичность'; pattern='самооцен|себя|красив|характер|личност|уверенн|стыд|вина' }
    'health' = @{ title='Здоровье, сон и физическое состояние'; pattern='здоров|сон|спать|тренир|питан|вес|живот|врач|лекар' }
    'work_finance' = @{ title='Работа, деньги и устойчивость'; pattern='работ|деньг|доход|ипотек|финанс|карьер|проект|квартир|дом' }
    'family_history' = @{ title='Семья и личная история'; pattern='семь|отец|пап|мам|детств|универ|школ|прошл|воспомин' }
    'social_life' = @{ title='Общение, дружба и социальная жизнь'; pattern='друг|общен|встреч|люд|компан|знаком|переписк|социал' }
    'future_plans' = @{ title='Планы, решения и будущее'; pattern='план|будущ|решен|хочу|намерен|следующ|переезд|покуп' }
}

$indexTopics = @()
foreach ($key in $topics.Keys) {
    $definition = $topics[$key]
    $refs = @($messages | Where-Object {
        $text = if ($_.payload.text) { [string]$_.payload.text } elseif ($_.payload.content) { ($_.payload.content | ConvertTo-Json -Compress) } else { '' }
        $text -match $definition.pattern
    } | ForEach-Object {
        [ordered]@{ message_id=$_.item_id; turn_id=$_.turn_id; role=$_.role; timestamp=$_.timestamp }
    })
    $userCount = @($refs | Where-Object role -eq 'user').Count
    $assistantCount = @($refs | Where-Object role -eq 'assistant').Count
    $summaryFile = "$key.md"
    $indexTopics += [ordered]@{
        id=$key; title=$definition.title; confidence='medium'; method='keyword-assisted';
        user_message_count=$userCount; assistant_message_count=$assistantCount;
        summary_file="topic-summaries/$summaryFile"; source_message_ids=@($refs.message_id)
    }
    $recentRefs = @($refs | Select-Object -Last 30)
    $lines = @(
        "# $($definition.title)", '',
        'Автоматически поддерживаемая тематическая карта. Она не является диагнозом или окончательной интерпретацией.', '',
        "- Прямые высказывания владельца: $userCount сообщений.",
        "- Ответы и гипотезы ассистента: $assistantCount сообщений.",
        '- Уверенность классификации: medium (по ключевым словам; одна реплика может входить в несколько тем).', '',
        '## Последние ссылки на источники', ''
    )
    $lines += @($recentRefs | ForEach-Object { "- `$($_.message_id)` — $($_.role), timestamp $($_.timestamp)" })
    Set-Content -LiteralPath (Join-Path $summariesRoot $summaryFile) -Value $lines -Encoding UTF8
}

$latest = $messages | Sort-Object timestamp | Select-Object -Last 1
$now = (Get-Date).ToUniversalTime().ToString('o')
$state = [ordered]@{
    schema_version=1; source_thread_id=$SourceThreadId; last_checked_at=$now;
    last_seen=[ordered]@{ message_id=$latest.item_id; turn_id=$latest.turn_id; timestamp=$latest.timestamp };
    transcript_message_count=$messages.Count; sync_mode='append_only'; status='no_changes'
}
$state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $memoryRoot 'sync-state.json') -Encoding UTF8

$index = [ordered]@{
    schema_version=1; generated_at=$now; source_thread_id=$SourceThreadId;
    classification='multi-label keyword-assisted'; message_count=$messages.Count; topics=$indexTopics
}
$index | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $memoryRoot 'topic-index.json') -Encoding UTF8

$profile = @(
    '# Личный профиль', '',
    'Этот файл — навигационный профиль памяти, а не медицинская оценка. Он разделяет прямые сообщения владельца и интерпретации ассистента.', '',
    "- Проиндексировано сообщений: $($messages.Count).",
    "- Прямые факты владельца представлены $(@($messages | Where-Object role -eq 'user').Count) пользовательскими сообщениями и привязаны к message IDs в тематическом индексе.",
    "- Гипотезы ассистента представлены $(@($messages | Where-Object role -eq 'assistant').Count) ответами; их нельзя считать подтверждёнными фактами без прямого высказывания владельца.",
    '- Уверенность текущего профиля: medium; тематическая классификация автоматическая и требует осторожного чтения первоисточника.', '',
    '## Тематические направления', ''
)
$profile += @($indexTopics | ForEach-Object { "- [$($_.title)](topic-summaries/$($_.id).md) — прямых сообщений владельца: $($_.user_message_count)." })
Set-Content -LiteralPath (Join-Path $memoryRoot 'personal-profile.md') -Value $profile -Encoding UTF8

$policy = @(
    '# Политика раскрытия', '',
    '- Raw transcript, raw-страницы и любые дословные личные сообщения нельзя передавать во внешний транспорт.',
    '- Каталог `psychologist-memory/` нельзя добавлять в Git.',
    '- Retrieval и тематические резюме не отменяют явные запреты владельца.',
    '- Не формулировать медицинские диагнозы.',
    '- В отчётах синхронизации не пересказывать личное содержание.'
)
Set-Content -LiteralPath (Join-Path $memoryRoot 'disclosure-policy.md') -Value $policy -Encoding UTF8

[ordered]@{ status='no_changes'; new_messages=0; topics=$indexTopics.Count; indexed_messages=$messages.Count; checked_at=$now } | ConvertTo-Json -Compress
