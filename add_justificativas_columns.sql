-- Script para adicionar colunas de justificativas na tabela ANEXOS
-- Execute este script no Azure SQL Database

USE [defaultdb];
GO

-- Verificar se as colunas já existem antes de adicionar
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ANEXOS') AND name = 'justificativa_secullum')
BEGIN
    ALTER TABLE ANEXOS ADD justificativa_secullum VARCHAR(255) NULL;
    PRINT 'Coluna justificativa_secullum adicionada com sucesso';
END
ELSE
BEGIN
    PRINT 'Coluna justificativa_secullum já existe';
END
GO

IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ANEXOS') AND name = 'justificativa_folha')
BEGIN
    ALTER TABLE ANEXOS ADD justificativa_folha VARCHAR(255) NULL;
    PRINT 'Coluna justificativa_folha adicionada com sucesso';
END
ELSE
BEGIN
    PRINT 'Coluna justificativa_folha já existe';
END
GO

-- Verificar estrutura atualizada
SELECT 
    COLUMN_NAME,
    DATA_TYPE,
    IS_NULLABLE,
    CHARACTER_MAXIMUM_LENGTH
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'ANEXOS'
ORDER BY ORDINAL_POSITION;
GO

PRINT '✅ Script executado com sucesso!';
PRINT 'As colunas justificativa_secullum e justificativa_folha foram adicionadas.';
